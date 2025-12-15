#!/usr/bin/env node

import { spawn } from 'child_process';
import { writeFile, readFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';

class AgentRunner {
  constructor() {
    this.config = {
      runId: process.env.RUN_ID,
      agentId: process.env.AGENT_ID, // Preset ID
      mode: process.env.MODE || 'generate',
      repoUrl: process.env.REPO_URL,
      branchName: process.env.BRANCH_NAME,
      baseBranch: process.env.BASE_BRANCH || 'HEAD',
      plan: process.env.PLAN_CONTENT ? JSON.parse(process.env.PLAN_CONTENT) : null,
      llm: {
        provider: process.env.LLM_PROVIDER,
        model: process.env.LLM_MODEL,
        cliModel: process.env.CLI_MODEL,
        temperature: process.env.LLM_TEMPERATURE,
        systemPrompt: process.env.SYSTEM_PROMPT
      },
      githubToken: process.env.GITHUB_TOKEN,
      timeoutMinutes: parseInt(process.env.TIMEOUT_MINUTES || '60'),
      maxIterations: parseInt(process.env.MAX_ITERATIONS || '5'),
      iterationTimeout: parseInt(process.env.ITERATION_TIMEOUT || '10'),
      candidateBranches: process.env.CANDIDATE_BRANCHES ? JSON.parse(process.env.CANDIDATE_BRANCHES) : []
    };

    this.dirs = {
      workspace: '/workspace',
      results: '/results'
    };

    this.startTime = Date.now();
    this.logStream = null;
  }

  async run() {
    await this.log(`🤖 Agent ${this.config.agentId} starting in ${this.config.mode} mode...`);
    
    try {
      // Setup
      await mkdir(this.dirs.results, { recursive: true });
      
      // Clone
      await this.cloneRepository();

      // Dispatch mode
      let result;
      switch (this.config.mode) {
        case 'generate':
          result = await this.runGenerate();
          break;
        case 'judge':
          result = await this.runJudge();
          break;
        case 'finalize':
          result = await this.runFinalize();
          break;
        default:
          throw new Error(`Unknown mode: ${this.config.mode}`);
      }

      await this.writeResult(result);
      await this.log(`✅ Agent completed successfully`);

    } catch (error) {
      await this.log(`❌ Agent failed: ${error.message}`);
      await this.log(error.stack);
      
      const errorResult = {
        run_id: this.config.runId,
        agent_id: this.config.agentId,
        branch_name: this.config.branchName,
        mode: this.config.mode,
        success: false,
        changes_made: [],
        build_status: 'failed',
        metrics: {
          files_changed: 0,
          lines_added: 0,
          lines_removed: 0,
          complexity_score: 0,
          quality_score: 0,
          execution_time_ms: Date.now() - this.startTime
        },
        error: error.message
      };
      
      await this.writeResult(errorResult);
      process.exit(1);
    }
  }

  // --- Modes ---

  async runGenerate() {
    await this.log('🚀 Starting Generation Phase');
    
    // Checkout new branch
    await this.git(['checkout', '-b', this.config.branchName]);
    
    // Setup environment (install deps, etc)
    await this.setupEnvironment();

    // Run baseline validation
    await this.log('📊 Running baseline validation...');
    const baseline = await this.runValidation();
    await this.log(`Baseline: Build=${baseline.buildPassed}, Tests=${baseline.testResults.passed}/${baseline.testResults.total}`);

    // Iteration Loop
    let iterations = 0;
    let success = false;
    
    while (iterations < this.config.maxIterations) {
      iterations++;
      await this.log(`\n🔄 Iteration ${iterations}/${this.config.maxIterations}`);

      // 1. Invoke LLM
      await this.invokeLLM(iterations, baseline);

      // 2. Validate
      const validation = await this.runValidation();
      await this.log(`Validation: Build=${validation.buildPassed}, Tests=${validation.testResults.passed}/${validation.testResults.total}`);

      // 3. Check termination
      const state = await this.readAgentState();
      
      // Commit progress
      const changes = await this.getChangedFiles();
      if (changes.length > 0) {
        await this.git(['add', '.']);
        await this.git(['commit', '-m', `feat: iteration ${iterations} implementation`]);
      }

      if (state.done && validation.buildPassed) { // Strictness can be adjusted
        await this.log('✅ Agent signaled completion and build passed');
        success = true;
        break;
      }
      
      if (changes.length === 0 && iterations > 1) {
         await this.log('⚠️ No changes made in this iteration. Aborting loop.');
         break;
      }
    }

    if (success) {
        await this.pushBranch();
    }

    const finalChanges = await this.getChangedFiles(this.config.baseBranch);
    const metrics = await this.calculateMetrics(finalChanges);

    return {
      run_id: this.config.runId,
      agent_id: this.config.agentId,
      branch_name: this.config.branchName,
      mode: 'generate',
      success: success,
      changes_made: finalChanges,
      test_results: (await this.runValidation()).testResults,
      build_status: success ? 'success' : 'failed',
      metrics: {
          ...metrics,
          execution_time_ms: Date.now() - this.startTime,
          iterations
      }
    };
  }

  async runJudge() {
    await this.log('⚖️ Starting Judge Phase');
    
    const judgements = [];
    const candidates = this.config.candidateBranches;

    if (!candidates || candidates.length === 0) {
        await this.log('⚠️ No candidate branches to judge.');
        return this.createEmptyResult('judge');
    }

    // Ensure we have all branches fetched
    await this.git(['fetch', '--all']);

    for (const branch of candidates) {
        await this.log(`\n🔎 Judging branch: ${branch}`);
        
        try {
            // Checkout candidate
            // Use force checkout to overwrite any local changes
            await this.git(['checkout', '-f', `origin/${branch}`]);
            await this.git(['clean', '-fdx']); // Clean untracked files

            const startingSha = await this.getHeadSha();
            
            // Setup
            await this.setupEnvironment();
            
            // Validate
            const validation = await this.runValidation();
            
            // Diff
            const diffStat = await this.exec(`git diff --shortstat origin/${this.config.baseBranch} HEAD`, true);
            const diffSummary = await this.exec(`git diff --name-status origin/${this.config.baseBranch} HEAD`, true);

            // Invoke LLM Judge
            const judgement = await this.invokeJudgeLLM(branch, validation, `${diffStat}\n${diffSummary}`);

            const violatedReadOnly = await this.enforceReadOnlyBranch(branch, startingSha);
            if (violatedReadOnly) {
                judgement.violation = true;
            }
            
            judgements.push(judgement);
            
            // Write individual judgement artifact
            const safeBranchName = branch.replace(/\//g, '-');
            await mkdir(join(this.dirs.results, 'judgements'), { recursive: true });
            await writeFile(
                join(this.dirs.results, 'judgements', `${safeBranchName}.json`), 
                JSON.stringify(judgement, null, 2)
            );

        } catch (e) {
            await this.log(`❌ Failed to judge branch ${branch}: ${e.message}`);
            // Record a failure judgement? or just skip?
        }
    }

    return {
        run_id: this.config.runId,
        agent_id: this.config.agentId,
        branch_name: 'judge-runner', // Judges don't produce a branch
        mode: 'judge',
        success: true,
        changes_made: [],
        build_status: 'success', // Runner itself succeeded
        metrics: {
            files_changed: 0,
            lines_added: 0,
            lines_removed: 0,
            complexity_score: 0,
            quality_score: 0,
            execution_time_ms: Date.now() - this.startTime
        },
        judgements: judgements
    };
  }

  async invokeJudgeLLM(branch, validation, diffInfo) {
      await this.log(`🤔 Asking ${this.config.llm.provider} to evaluate...`);
      
      const prompt = `
You are a senior code reviewer. You are evaluating a solution implemented by an AI agent.

PLAN:
${JSON.stringify(this.config.plan, null, 2)}

CANDIDATE BRANCH: ${branch}

VALIDATION RESULTS:
- Build Passed: ${validation.buildPassed}
- Tests: ${validation.testResults.passed} passed, ${validation.testResults.failed} failed
- E2E: (Pass/Fail status is implied by logs, assume check manual validation if not provided)

DIFF SUMMARY:
${diffInfo}

INSTRUCTIONS:
1. Evaluate the solution based on Correctness, Completeness, Code Quality, and adherence to the Plan.
2. Provide a score (0-100).
3. List "must_fix" issues (critical bugs, plan violations).
4. List "nice_to_have" suggestions.
5. Return ONLY a JSON object matching this schema:
{
  "candidate_branch": "${branch}",
  "judge_preset": "${this.config.agentId}",
  "overall_score": number,
  "sub_scores": {
    "correctness": number,
    "completeness": number,
    "code_quality": number,
    "test_quality": number,
    "maintainability": number
  },
  "recommendations": {
    "must_fix": string[],
    "nice_to_have": string[]
  },
  "confidence": number, // 0.0 to 1.0
  "violation": boolean // true if they modified files they shouldn't have (n/a here since read-only)
}
`;
      // Call LLM
      // We need to capture stdout from the CLI.
      // Assuming CLI prints the response to stdout.
      
      let output = '';
      try {
        if (this.config.llm.provider === 'openai') {
            output = await this.execFile('codex', ['--model', this.config.llm.cliModel || 'o3', '--approval-mode', 'full-auto', '--quiet', '--prompt', prompt], true);
        } else if (this.config.llm.provider === 'anthropic') {
            output = await this.execFile('claude', ['-p', prompt, '--print'], true);
        } else {
            throw new Error(`Unsupported provider: ${this.config.llm.provider}`);
        }
        
        // Extract JSON
        const jsonMatch = output.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }
        throw new Error('No JSON found in LLM response');
      } catch (e) {
          await this.log(`⚠️ Judge LLM parse failed: ${e.message}`);
          return {
              candidate_branch: branch,
              judge_preset: this.config.agentId,
              overall_score: 0,
              sub_scores: { correctness: 0, completeness: 0, code_quality: 0, test_quality: 0, maintainability: 0 },
              recommendations: { must_fix: ["Failed to parse judge output"], nice_to_have: [] },
              confidence: 0,
              violation: false,
              error: e.message,
              raw_output: output
          };
      }
  }

  createEmptyResult(mode) {
      return {
        run_id: this.config.runId,
        agent_id: this.config.agentId,
        branch_name: '',
        mode: mode,
        success: true,
        changes_made: [],
        build_status: 'not_run',
        metrics: { files_changed: 0, lines_added: 0, lines_removed: 0, complexity_score: 0, quality_score: 0, execution_time_ms: 0 }
      };
  }

  async runFinalize() {
    await this.log('🏁 Starting Finalize Phase');
    
    // Config should have branchName set to the winner branch
    await this.log(`Winner branch: ${this.config.branchName}`);
    
    // Checkout winner branch
    await this.git(['fetch', 'origin']);
    await this.git(['checkout', this.config.branchName]);
    
    // Setup
    await this.setupEnvironment();
    
    // Recommendations (passed via env or we can assume they are in the plan context if updated, 
    // but for v1 let's assume the LLM prompt handles it based on plan updates or just does a final polish).
    // Actually, Milestone 5 says: "Prompt includes Consolidated recommendations"
    // We can pass consolidated recommendations via environment variable `CONSOLIDATED_RECOMMENDATIONS`
    
    const recommendations = process.env.CONSOLIDATED_RECOMMENDATIONS 
        ? JSON.parse(process.env.CONSOLIDATED_RECOMMENDATIONS) 
        : [];
        
    await this.log(`Applying ${recommendations.length} consolidated recommendations...`);

    // Reuse invokeLLM but with a modified prompt for finalization
    // We can override the plan in config to include recommendations, or just append to prompt.
    // For simplicity, let's use a specialized finalizer loop.
    
    let iterations = 0;
    let success = false;
    
    // Baseline before finalization
    const baseline = await this.runValidation();
    
    while (iterations < this.config.maxIterations) {
        iterations++;
        await this.log(`\n🔨 Finalization Iteration ${iterations}`);
        
        await this.invokeFinalizerLLM(iterations, baseline, recommendations);
        
        const validation = await this.runValidation();
        await this.log(`Validation: Build=${validation.buildPassed}, Tests=${validation.testResults.passed}`);
        
        const state = await this.readAgentState();
        
        const changes = await this.getChangedFiles();
        if (changes.length > 0) {
            await this.git(['add', '.']);
            await this.git(['commit', '-m', `feat: finalization iteration ${iterations}`]);
        }
        
        if (state.done && validation.buildPassed && validation.testResults.failed === 0) {
            await this.log('✅ Finalization complete and verified.');
            success = true;
            break;
        }
        
        if (changes.length === 0 && iterations > 1) {
            break;
        }
    }
    
    if (success) {
        // Squash or just push? Plan says "makes final commit".
        // Let's create a clean final commit message
        await this.git(['commit', '--allow-empty', '-m', `feat: finalize implementation of ${this.config.plan.summary}`]);
        await this.pushBranch();
    }
    
    const finalChanges = await this.getChangedFiles(this.config.baseBranch);
    
    return {
        run_id: this.config.runId,
        agent_id: this.config.agentId,
        branch_name: this.config.branchName,
        mode: 'finalize',
        success: success,
        changes_made: finalChanges,
        build_status: success ? 'success' : 'failed',
        metrics: {
            files_changed: finalChanges.length,
            lines_added: 0, // TODO: calc
            lines_removed: 0,
            complexity_score: 0,
            quality_score: 0,
            execution_time_ms: Date.now() - this.startTime
        }
    };
  }

  async invokeFinalizerLLM(iteration, baseline, recommendations) {
      await this.log(`🤖 Invoking Finalizer...`);
      
      const recsStr = recommendations.map(r => `- ${r}`).join('\n');
      
      const instruction = `
You are the Finalizer Agent. Your job is to polish the winning solution and apply peer review recommendations.

PLAN:
${JSON.stringify(this.config.plan, null, 2)}

CONSOLIDATED RECOMMENDATIONS (Apply these):
${recsStr}

BASELINE STATUS:
Build Passed: ${baseline.buildPassed}
Tests Passed: ${baseline.testResults.passed}

INSTRUCTIONS:
1. Apply the recommendations to the codebase.
2. Ensure all tests pass.
3. When finished, write ".pangloss/state.json" with {"done": true}.
4. Do NOT make unnecessary changes.

Make your changes now.
`;
      // ... Call CLI similar to invokeLLM ...
      // Refactor invokeLLM to take a prompt string to avoid duplication?
      // For now, duplicate logic for speed.
      
      try {
        if (this.config.llm.provider === 'openai') {
            await this.execFile('codex', ['--model', this.config.llm.cliModel || 'o3', '--approval-mode', 'full-auto', '--quiet', '--prompt', instruction], true);
        } else if (this.config.llm.provider === 'anthropic') {
            await this.execFile('claude', ['-p', instruction, '--print'], true);
        } else {
            throw new Error(`Unsupported provider: ${this.config.llm.provider}`);
        }
    } catch (e) {
        await this.log(`⚠️ LLM invocation failed: ${e.message}`);
    }
  }

  // --- Helpers ---

  async setupEnvironment() {
    await this.log('📦 Installing dependencies...');
    try {
        if (existsSync(join(this.dirs.workspace, 'package.json'))) {
            await this.exec('npm install');
            
            // Check for playwright
            try {
                // Ensure playwright browsers are installed if the project uses playwright
                const pkg = JSON.parse(await readFile(join(this.dirs.workspace, 'package.json'), 'utf-8'));
                const hasPlaywright = (pkg.dependencies && pkg.dependencies['@playwright/test']) || 
                                      (pkg.devDependencies && pkg.devDependencies['@playwright/test']);
                
                if (hasPlaywright) {
                    await this.log('🎭 Installing Playwright browsers...');
                    await this.exec('npx playwright install --with-deps');
                } else {
                    // Agent might install it later, but for now we wait
                }
            } catch (e) {
                await this.log(`⚠️ Failed to check/install Playwright: ${e.message}`);
            }
        }
    } catch (e) {
        await this.log(`⚠️ Dependency install failed: ${e.message}`);
    }
  }

  async invokeLLM(iteration, baseline) {
    await this.log(`🤖 Invoking LLM (${this.config.llm.provider})...`);
    
    // Construct Prompt
    const planStr = JSON.stringify(this.config.plan, null, 2);
    const instruction = `
You are an expert AI software engineer. You are implementing a feature based on a plan.
Current Iteration: ${iteration}

PLAN:
${planStr}

INSTRUCTIONS:
1. Implement the plan step-by-step.
2. Write unit tests and E2E tests (using Playwright) to verify your work.
3. Fix any build or test failures.
4. When you are finished with the entire plan, write a file named ".pangloss/state.json" with the content: {"done": true, "summary": "..."}
5. If you are not done, write ".pangloss/state.json" with: {"done": false, "summary": "...", "remaining_work": [...]}

BASELINE STATUS:
Build Passed: ${baseline.buildPassed}
Tests Passed: ${baseline.testResults.passed}

Make your changes now.
`;

    // Ensure .pangloss dir exists
    await mkdir(join(this.dirs.workspace, '.pangloss'), { recursive: true });

    // Call CLI
    try {
        if (this.config.llm.provider === 'openai') {
            // Codex CLI
            await this.execFile('codex', ['--model', this.config.llm.cliModel || 'o3', '--approval-mode', 'full-auto', '--quiet', '--prompt', instruction], true);
        } else if (this.config.llm.provider === 'anthropic') {
            // Claude CLI
            // Note: Claude CLI might need 'echo prompt | claude' or similar depending on version. 
            // Using -p flag as per previous implementation
            await this.execFile('claude', ['-p', instruction, '--print'], true);
        } else {
            throw new Error(`Unsupported provider: ${this.config.llm.provider}`);
        }
    } catch (e) {
        await this.log(`⚠️ LLM invocation failed (non-fatal): ${e.message}`);
    }
  }

  async readAgentState() {
      try {
          const path = join(this.dirs.workspace, '.pangloss', 'state.json');
          if (existsSync(path)) {
              return JSON.parse(await readFile(path, 'utf-8'));
          }
      } catch (e) {
          // ignore
      }
      return { done: false };
  }

  async runValidation() {
      const results = {
          buildPassed: false,
          testResults: { passed: 0, failed: 0, total: 0, duration_ms: 0 }
      };

      // Build
      try {
          // Heuristic for build
          if (await this.hasScript('build')) {
              await this.exec('npm run build');
              results.buildPassed = true;
          } else {
              results.buildPassed = true; // No build script = pass?
          }
      } catch (e) {
          results.buildPassed = false;
      }

      // Test
      try {
          // Heuristic for test
          // This is a naive parser, real implementation would need structured output (e.g. json reporters)
          let output = '';
          if (await this.hasScript('test')) {
              output = await this.exec('npm test');
          }
          
          // Basic parsing
          const passedMatch = output.match(/(\d+)\s+passed/i);
          const failedMatch = output.match(/(\d+)\s+failed/i);
          if (passedMatch) results.testResults.passed = parseInt(passedMatch[1]);
          if (failedMatch) results.testResults.failed = parseInt(failedMatch[1]);
          results.testResults.total = results.testResults.passed + results.testResults.failed;
      } catch (e) {
          // Attempt parsing from error output too
          results.testResults.failed = 1; // At least one failure
      }

      // E2E (Playwright)
      try {
          if (await this.hasScript('e2e') || existsSync(join(this.dirs.workspace, 'playwright.config.ts'))) {
              await this.exec('npx playwright test');
              // Would parse output here
          }
      } catch (e) {
          // E2E failed
      }

      return results;
  }

  async hasScript(scriptName) {
      try {
          const pkg = JSON.parse(await readFile(join(this.dirs.workspace, 'package.json'), 'utf-8'));
          return pkg.scripts && pkg.scripts[scriptName];
      } catch (e) {
          return false;
      }
  }

  async cloneRepository() {
    await this.log(`Cloning ${this.config.repoUrl}...`);
    // Inject token into URL
    const authUrl = this.config.repoUrl.replace('https://github.com/', `https://${this.config.githubToken}@github.com/`);
    
    // Suppress token in logs by not printing command
    await this.exec(`git clone ${authUrl} ${this.dirs.workspace}`, true);
    
    // Config git
    await this.git(['config', 'user.email', 'agent@pangloss.ai']);
    await this.git(['config', 'user.name', `Pangloss ${this.config.agentId}`]);
  }

  async git(args) {
    return this.exec(`git ${args.join(' ')}`);
  }

  async getHeadSha() {
      try {
          return await this.exec('git rev-parse HEAD', true);
      } catch (e) {
          return '';
      }
  }

  async enforceReadOnlyBranch(branch, startingSha) {
      const currentSha = await this.getHeadSha();
      let status = '';
      try {
          status = await this.exec('git status --porcelain', true);
      } catch (e) {
          status = '';
      }

      const dirty = status.trim().length > 0;
      const headChanged = startingSha && currentSha && startingSha !== currentSha;

      if (dirty || headChanged) {
          await this.log('⚠️ Judge mode must be read-only. Resetting repository state.');
          await this.git(['checkout', '-f', `origin/${branch}`]);
          await this.git(['clean', '-fdx']);
          return true;
      }

      return false;
  }

  async pushBranch() {
      const authUrl = this.config.repoUrl.replace('https://github.com/', `https://${this.config.githubToken}@github.com/`);
      await this.exec(`git remote set-url origin ${authUrl}`, true);
      await this.git(['push', 'origin', this.config.branchName]);
  }

  async getChangedFiles(base = 'HEAD') {
      try {
          const stdout = await this.exec(`git diff --name-only ${base}`);
          return stdout.split('\n').filter(l => l.trim());
      } catch (e) {
          return [];
      }
  }

  async calculateMetrics(files) {
      try {
          const stdout = await this.exec('git diff --shortstat HEAD~1 HEAD');
          // Example: " 1 file changed, 2 insertions(+), 1 deletion(-)"
          const added = (stdout.match(/(\d+) insertion/) || [])[1] || 0;
          const removed = (stdout.match(/(\d+) deletion/) || [])[1] || 0;
          return {
              files_changed: files.length,
              lines_added: parseInt(added),
              lines_removed: parseInt(removed),
              complexity_score: 0,
              quality_score: 0
          };
      } catch (e) {
          return { files_changed: files.length, lines_added: 0, lines_removed: 0, complexity_score: 0, quality_score: 0 };
      }
  }

  async exec(command, suppressLog = false) {
    if (!suppressLog) await this.log(`> ${command}`);
    return new Promise((resolve, reject) => {
        const proc = spawn(command, { 
            shell: true, 
            cwd: this.dirs.workspace,
            env: { ...process.env, CI: 'true' }
        });
        
        let stdout = '';
        
        proc.stdout.on('data', d => { 
            const s = d.toString();
            stdout += s;
            process.stdout.write(s); 
        });
        proc.stderr.on('data', d => { 
            const s = d.toString();
            process.stderr.write(s); 
        });
        
        proc.on('close', code => {
            if (code === 0) resolve(stdout.trim());
            else reject(new Error(`Command failed with code ${code}`));
        });
    });
  }

  async execFile(command, args, suppressLog = false) {
    if (!suppressLog) await this.log(`> ${command} ${args.join(' ')}`);
    return new Promise((resolve, reject) => {
        const proc = spawn(command, args, {
            cwd: this.dirs.workspace,
            env: { ...process.env, CI: 'true' }
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', d => {
            const s = d.toString();
            stdout += s;
            process.stdout.write(s);
        });
        proc.stderr.on('data', d => {
            const s = d.toString();
            stderr += s;
            process.stderr.write(s);
        });

        proc.on('close', code => {
            if (code === 0) resolve(stdout.trim());
            else reject(new Error(`Command failed with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
        });
    });
  }

  async log(msg) {
    const ts = new Date().toISOString();
    const line = `[${ts}] ${msg}\n`;
    process.stdout.write(line);
    
    try {
        await writeFile(join(this.dirs.results, 'log.txt'), line, { flag: 'a' });
    } catch (e) {
        // ignore
    }
  }

  async writeResult(result) {
    await writeFile(join(this.dirs.results, 'result.json'), JSON.stringify(result, null, 2));
  }
}

// Run
const agent = new AgentRunner();
agent.run().catch(err => {
    console.error('Fatal agent error:', err);
    process.exit(1);
});
