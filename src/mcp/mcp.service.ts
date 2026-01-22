import { Injectable, Logger, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import axios from 'axios';
import {
    RepoAnalysisSummary,
    ActionableItem,
    RepoAnalysisResponse,
    DockerfileGenerationResponse,
    DeepCodeAnalysis,
} from './dto/repo-analysis-summary.dto';

/**
 * McpService - Smart Repository Analysis with Gitignore Exclusion
 * 
 * Features:
 * - Uses search_code but excludes .gitignore patterns
 * - Dynamic detection (no hardcoded language checks)
 * - Returns structured JSON with detected/missing fields
 * - Enhanced analysis with abstracted frontend response
 * - Dockerfile generation using MCP create_or_update_file tool
 */
@Injectable()
export class McpService {
    private readonly logger = new Logger(McpService.name);

    /**
     * Analyze repository and return structured JSON
     */
    async analyzeRepository(
        userToken: string,
        repoFullName: string,
    ): Promise<RepositoryAnalysis> {
        const [owner, repo] = this.parseRepoName(repoFullName);
        this.logger.log(`🔍 Starting smart analysis for: ${owner}/${repo}`);

        let client: Client | null = null;
        let transport: StdioClientTransport | null = null;

        try {
            client = new Client({ name: 'mcp-repo-analyzer', version: '3.0.0' });

            transport = new StdioClientTransport({
                command: 'npx',
                args: ['-y', '@modelcontextprotocol/server-github'],
                env: { ...process.env, GITHUB_PERSONAL_ACCESS_TOKEN: userToken },
            });

            await client.connect(transport);
            this.logger.log('✅ Connected to GitHub MCP server');

            const analysis = await this.executeSmartAnalysis(client, owner, repo, userToken);

            this.logger.log(`✅ Analysis complete for ${owner}/${repo}`);
            return analysis;

        } catch (error) {
            this.logger.error(`❌ Analysis failed: ${(error as Error).message}`);
            throw new InternalServerErrorException(`Repository analysis failed: ${(error as Error).message}`);
        } finally {
            if (client) {
                try { await client.close(); this.logger.log('🧹 MCP subprocess cleaned up'); } catch { }
            }
        }
    }

    /**
     * Smart analysis with gitignore exclusion
     */
    private async executeSmartAnalysis(
        client: Client,
        owner: string,
        repo: string,
        userToken: string,
    ): Promise<RepositoryAnalysis> {
        const analysis: RepositoryAnalysis = {
            repository: { owner, repo },
            detected: {
                language: null,
                frameworks: [],
                databases: [],
                runtime: {},
                buildConfig: {},
                ports: [],
                envVars: [],
                docker: null,
                cicd: null,
            },
            missing: [],
            files: {},
            rawData: {},
        };

        // Step 1: Get repo structure
        this.logger.log('📂 Fetching repository structure...');
        const repoContents = await this.getRepoContents(owner, repo, userToken);
        analysis.rawData.repoContents = repoContents;

        if (repoContents.length === 0) {
            analysis.missing.push('Repository appears empty');
            return analysis;
        }

        // Step 2: Fetch .gitignore to know what to exclude
        const gitignore = await this.fetchFile(owner, repo, '.gitignore', userToken);
        const excludePatterns = this.parseGitignore(gitignore || '');
        analysis.rawData.excludePatterns = excludePatterns;
        this.logger.log(`📋 Exclude patterns: ${excludePatterns.length} from .gitignore`);

        // Step 3: Fetch all important manifest files dynamically
        const manifestFiles = this.identifyManifestFiles(repoContents);
        for (const file of manifestFiles) {
            const content = await this.fetchFile(owner, repo, file.path, userToken);
            if (content) {
                analysis.files[file.name] = content;
                this.logger.log(`✅ Fetched: ${file.name}`);
            }
        }

        // Step 4: Parse manifest files to extract info
        this.parseAllManifests(analysis);

        // Step 5: Use search_code for specific things (with exclusion)
        await this.smartSearch(client, owner, repo, analysis, excludePatterns);

        // Step 6: Identify what's missing
        this.identifyMissing(analysis);

        return analysis;
    }

    /**
     * Get repo contents via GitHub API
     */
    private async getRepoContents(owner: string, repo: string, userToken: string): Promise<RepoFile[]> {
        try {
            const response = await axios.get(`https://api.github.com/repos/${owner}/${repo}/contents`, {
                headers: { Authorization: `Bearer ${userToken}`, Accept: 'application/vnd.github.v3+json' },
            });
            return response.data;
        } catch {
            return [];
        }
    }

    /**
     * Fetch single file content
     */
    private async fetchFile(owner: string, repo: string, path: string, userToken: string): Promise<string | null> {
        try {
            const response = await axios.get(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
                headers: { Authorization: `Bearer ${userToken}`, Accept: 'application/vnd.github.v3+json' },
            });
            if (response.data.content && response.data.encoding === 'base64') {
                return Buffer.from(response.data.content, 'base64').toString('utf-8');
            }
            return null;
        } catch {
            return null;
        }
    }

    /**
     * Parse .gitignore into exclude patterns
     */
    private parseGitignore(content: string): string[] {
        return content
            .split('\n')
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('#'))
            .map(line => line.replace(/\/$/, '')); // Remove trailing slashes
    }

    /**
     * Identify all manifest/config files in repo
     */
    private identifyManifestFiles(files: RepoFile[]): RepoFile[] {
        const manifestPatterns = [
            // Node.js
            'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
            'tsconfig.json', '.nvmrc', 'nest-cli.json', 'vite.config.ts', 'vite.config.js',
            'next.config.js', 'next.config.mjs', 'angular.json', 'nuxt.config.ts',
            // Python
            'requirements.txt', 'pyproject.toml', 'setup.py', 'setup.cfg', 'Pipfile', 'runtime.txt',
            // Java
            'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'gradle.properties',
            'application.properties', 'application.yml', 'application.yaml',
            // Go
            'go.mod', 'go.sum',
            // Rust
            'Cargo.toml', 'Cargo.lock',
            // Ruby
            'Gemfile', 'Gemfile.lock',
            // PHP
            'composer.json', 'composer.lock',
            // Docker/Infra
            'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', '.dockerignore',
            // CI/CD
            '.github', '.gitlab-ci.yml', 'Jenkinsfile', 'bitbucket-pipelines.yml',
            // Env
            '.env.example', '.env.sample', '.env.template',
            // Other
            '.gitignore', 'README.md', 'Makefile', 'Procfile', 'fly.toml', 'vercel.json', 'netlify.toml',
        ];

        return files.filter(f =>
            manifestPatterns.some(p => f.name.toLowerCase() === p.toLowerCase() || f.name.endsWith(p))
        );
    }

    /**
     * Parse all fetched manifest files
     */
    private parseAllManifests(analysis: RepositoryAnalysis): void {
        const files = analysis.files;

        // Parse package.json (Node.js)
        if (files['package.json']) {
            try {
                const pkg = JSON.parse(files['package.json']);
                analysis.detected.language = pkg.devDependencies?.typescript ? 'TypeScript' : 'JavaScript';
                analysis.detected.buildConfig = {
                    name: pkg.name,
                    version: pkg.version,
                    description: pkg.description,
                    scripts: pkg.scripts,
                    engines: pkg.engines,
                };

                const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
                analysis.detected.frameworks = this.extractFrameworks(allDeps);
                analysis.detected.databases = this.extractDatabases(allDeps);

                // Extract from scripts
                if (pkg.scripts) {
                    const portMatch = JSON.stringify(pkg.scripts).match(/PORT[=:]\s*(\d+)/i);
                    if (portMatch) analysis.detected.ports.push(portMatch[1]);
                }
            } catch (e) {
                this.logger.warn('Failed to parse package.json');
            }
        }

        // Parse requirements.txt (Python)
        if (files['requirements.txt']) {
            analysis.detected.language = 'Python';
            const deps = files['requirements.txt'].split('\n').filter(l => l.trim() && !l.startsWith('#'));
            analysis.detected.frameworks = this.extractPythonFrameworks(deps);
            analysis.detected.databases = this.extractPythonDatabases(deps);
        }

        // Parse pyproject.toml (Python)
        if (files['pyproject.toml']) {
            analysis.detected.language = 'Python';
            const nameMatch = files['pyproject.toml'].match(/name\s*=\s*"([^"]+)"/);
            if (nameMatch) analysis.detected.buildConfig.name = nameMatch[1];
        }

        // Parse pom.xml (Java)
        if (files['pom.xml']) {
            analysis.detected.language = 'Java';
            analysis.detected.frameworks = this.extractJavaFrameworks(files['pom.xml']);
        }

        // Parse build.gradle (Java/Kotlin)
        if (files['build.gradle'] || files['build.gradle.kts']) {
            const gradle = files['build.gradle'] || files['build.gradle.kts'];
            analysis.detected.language = gradle.includes('kotlin') ? 'Kotlin' : 'Java';
            analysis.detected.frameworks = this.extractJavaFrameworks(gradle);
        }

        // Parse go.mod (Go)
        if (files['go.mod']) {
            analysis.detected.language = 'Go';
            const goVersion = files['go.mod'].match(/go\s+(\d+\.\d+)/);
            if (goVersion) analysis.detected.runtime.goVersion = goVersion[1];
        }

        // Parse Cargo.toml (Rust)
        if (files['Cargo.toml']) {
            analysis.detected.language = 'Rust';
        }

        // Parse Gemfile (Ruby)
        if (files['Gemfile']) {
            analysis.detected.language = 'Ruby';
            if (files['Gemfile'].includes('rails')) analysis.detected.frameworks.push('Ruby on Rails');
            if (files['Gemfile'].includes('sinatra')) analysis.detected.frameworks.push('Sinatra');
        }

        // Parse composer.json (PHP)
        if (files['composer.json']) {
            analysis.detected.language = 'PHP';
            try {
                const composer = JSON.parse(files['composer.json']);
                if (composer.require?.['laravel/framework']) analysis.detected.frameworks.push('Laravel');
                if (composer.require?.['symfony/framework-bundle']) analysis.detected.frameworks.push('Symfony');
            } catch { }
        }

        // Parse Dockerfile
        if (files['Dockerfile']) {
            const dockerfile = files['Dockerfile'];
            analysis.detected.docker = {
                exists: true,
                baseImage: dockerfile.match(/FROM\s+(\S+)/i)?.[1] || null,
                exposedPorts: (dockerfile.match(/EXPOSE\s+(\d+)/gi) || []).map(m => m.replace(/EXPOSE\s+/i, '')),
                workdir: dockerfile.match(/WORKDIR\s+(\S+)/i)?.[1] || null,
                cmd: dockerfile.match(/CMD\s+(.+)/i)?.[1] || null,
            };
            analysis.detected.ports.push(...(analysis.detected.docker.exposedPorts || []));
        }

        // Parse docker-compose
        if (files['docker-compose.yml'] || files['docker-compose.yaml']) {
            const compose = files['docker-compose.yml'] || files['docker-compose.yaml'];
            const services = compose.match(/^\s{2}(\w+):/gm);
            analysis.detected.docker = analysis.detected.docker || { exists: false };
            analysis.detected.docker.composeServices = services?.map(s => s.trim().replace(':', '')) || [];

            // Extract ports from compose
            const portMatches = compose.match(/["']?(\d+):(\d+)["']?/g);
            if (portMatches) {
                portMatches.forEach(p => {
                    const port = p.match(/(\d+):(\d+)/);
                    if (port) analysis.detected.ports.push(port[2]);
                });
            }
        }

        // Parse .env.example
        if (files['.env.example'] || files['.env.sample'] || files['.env.template']) {
            const envFile = files['.env.example'] || files['.env.sample'] || files['.env.template'];
            analysis.detected.envVars = envFile
                .split('\n')
                .filter(l => l.includes('=') && !l.trim().startsWith('#'))
                .map(l => l.split('=')[0].trim());

            // Check for PORT in env
            const portVar = envFile.match(/PORT\s*=\s*(\d+)/i);
            if (portVar) analysis.detected.ports.push(portVar[1]);
        }

        // Parse .nvmrc
        if (files['.nvmrc']) {
            analysis.detected.runtime.nodeVersion = files['.nvmrc'].trim();
        }

        // Detect CI/CD
        if (files['.github'] || analysis.rawData.repoContents?.some((f: RepoFile) => f.name === '.github')) {
            analysis.detected.cicd = { platform: 'GitHub Actions', configured: true };
        }
        if (files['.gitlab-ci.yml']) {
            analysis.detected.cicd = { platform: 'GitLab CI', configured: true };
        }
        if (files['Jenkinsfile']) {
            analysis.detected.cicd = { platform: 'Jenkins', configured: true };
        }

        // Deduplicate ports
        analysis.detected.ports = [...new Set(analysis.detected.ports)];
    }

    /**
     * Smart search with gitignore exclusion
     */
    private async smartSearch(
        client: Client,
        owner: string,
        repo: string,
        analysis: RepositoryAnalysis,
        excludePatterns: string[],
    ): Promise<void> {
        // Build exclusion query part
        const excludeQuery = excludePatterns
            .filter(p => ['node_modules', 'dist', 'build', '.git', 'vendor', '__pycache__', 'target'].includes(p))
            .map(p => `-path:${p}`)
            .join(' ');

        // Search for PORT configurations (only in source files)
        const portSearches = [
            { query: 'PORT repo:' + `${owner}/${repo} ${excludeQuery}`, type: 'port' },
            { query: 'listen repo:' + `${owner}/${repo} ${excludeQuery}`, type: 'port' },
            { query: 'EXPOSE repo:' + `${owner}/${repo} ${excludeQuery}`, type: 'port' },
        ];

        for (const search of portSearches) {
            try {
                const result = await client.callTool({
                    name: 'search_code',
                    arguments: { q: search.query },
                });

                if (result?.content && Array.isArray(result.content)) {
                    const textContent = result.content.find((c: any) => c.type === 'text');
                    if (textContent?.text) {
                        // Extract port numbers from search results
                        const portMatches = textContent.text.match(/(?:PORT|listen|EXPOSE)[^\d]*(\d{4,5})/gi);
                        if (portMatches) {
                            portMatches.forEach((m: string) => {
                                const port = m.match(/(\d{4,5})/);
                                if (port && !analysis.detected.ports.includes(port[1])) {
                                    analysis.detected.ports.push(port[1]);
                                }
                            });
                        }
                    }
                }
            } catch {
                // Search failed, continue
            }
        }

        // Deduplicate
        analysis.detected.ports = [...new Set(analysis.detected.ports)];
    }

    /**
     * Identify what's missing for deployment
     */
    private identifyMissing(analysis: RepositoryAnalysis): void {
        if (!analysis.detected.docker?.exists) {
            analysis.missing.push('Dockerfile not found');
        }
        if (!analysis.detected.cicd) {
            analysis.missing.push('CI/CD configuration not found');
        }
        if (analysis.detected.ports.length === 0) {
            analysis.missing.push('No exposed ports detected');
        }
        if (analysis.detected.envVars.length === 0) {
            analysis.missing.push('No .env.example found - environment variables unclear');
        }
        if (!analysis.detected.buildConfig?.scripts?.build) {
            analysis.missing.push('No build script defined');
        }
        if (!analysis.detected.buildConfig?.scripts?.start && !analysis.detected.buildConfig?.scripts?.['start:prod']) {
            analysis.missing.push('No start/production script defined');
        }
    }

    // Helper methods for framework extraction
    private extractFrameworks(deps: Record<string, string>): string[] {
        const frameworks: string[] = [];
        const map: Record<string, string> = {
            'react': 'React', 'react-dom': 'React', 'next': 'Next.js', 'vue': 'Vue.js',
            '@angular/core': 'Angular', 'express': 'Express.js', '@nestjs/core': 'NestJS',
            '@nestjs/common': 'NestJS', 'fastify': 'Fastify', 'koa': 'Koa', 'hapi': 'Hapi',
            'socket.io': 'Socket.IO', '@socket.io/server': 'Socket.IO',
            'tailwindcss': 'Tailwind CSS', 'vite': 'Vite',
            'graphql': 'GraphQL', '@apollo/server': 'Apollo GraphQL',
            'passport': 'Passport.js', 'nuxt': 'Nuxt.js', 'svelte': 'Svelte',
            'electron': 'Electron', 'remix': 'Remix',
        };
        for (const [k, v] of Object.entries(map)) {
            if (deps[k] && !frameworks.includes(v)) frameworks.push(v);
        }
        return frameworks;
    }

    private extractDatabases(deps: Record<string, string>): string[] {
        const databases: string[] = [];
        const map: Record<string, string> = {
            'prisma': 'Prisma', '@prisma/client': 'Prisma',
            'mongoose': 'MongoDB', 'mongodb': 'MongoDB',
            'typeorm': 'TypeORM', 'sequelize': 'Sequelize',
            'pg': 'PostgreSQL', 'mysql2': 'MySQL', 'mysql': 'MySQL',
            'redis': 'Redis', 'ioredis': 'Redis',
            'sqlite3': 'SQLite', 'better-sqlite3': 'SQLite',
        };
        for (const [k, v] of Object.entries(map)) {
            if (deps[k] && !databases.includes(v)) databases.push(v);
        }
        return databases;
    }

    private extractPythonFrameworks(deps: string[]): string[] {
        const frameworks: string[] = [];
        const map: Record<string, string> = {
            'flask': 'Flask', 'django': 'Django', 'fastapi': 'FastAPI',
            'starlette': 'Starlette', 'tornado': 'Tornado', 'aiohttp': 'aiohttp',
            'celery': 'Celery', 'pytest': 'Pytest',
        };
        for (const dep of deps) {
            const name = dep.toLowerCase().split('==')[0].split('>=')[0].replace(/[-_]/g, '');
            for (const [k, v] of Object.entries(map)) {
                if (name.includes(k) && !frameworks.includes(v)) frameworks.push(v);
            }
        }
        return frameworks;
    }

    private extractPythonDatabases(deps: string[]): string[] {
        const databases: string[] = [];
        const map: Record<string, string> = {
            'sqlalchemy': 'SQLAlchemy', 'pymongo': 'MongoDB', 'redis': 'Redis',
            'psycopg2': 'PostgreSQL', 'mysqlclient': 'MySQL', 'pymysql': 'MySQL',
        };
        for (const dep of deps) {
            const name = dep.toLowerCase().split('==')[0].split('>=')[0].replace(/[-_]/g, '');
            for (const [k, v] of Object.entries(map)) {
                if (name.includes(k) && !databases.includes(v)) databases.push(v);
            }
        }
        return databases;
    }

    private extractJavaFrameworks(content: string): string[] {
        const frameworks: string[] = [];
        if (content.includes('spring-boot')) frameworks.push('Spring Boot');
        if (content.includes('spring-webflux')) frameworks.push('Spring WebFlux');
        if (content.includes('quarkus')) frameworks.push('Quarkus');
        if (content.includes('micronaut')) frameworks.push('Micronaut');
        if (content.includes('hibernate')) frameworks.push('Hibernate');
        if (content.includes('jakarta')) frameworks.push('Jakarta EE');
        return frameworks;
    }

    private parseRepoName(repoFullName: string): [string, string] {
        if (!repoFullName || !repoFullName.includes('/')) {
            throw new BadRequestException('Invalid repository format. Use "owner/repo"');
        }
        const [owner, repo] = repoFullName.split('/');
        if (!owner || !repo) throw new BadRequestException('Invalid repository format');
        return [owner, repo];
    }

    // ==================== ENHANCED ANALYSIS METHODS ====================

    /**
     * Enhanced repository analysis returning abstracted JSON for frontend
     * This is the main method for the new analysis endpoint
     */
    async analyzeRepositoryEnhanced(
        userToken: string,
        repoFullName: string,
    ): Promise<RepoAnalysisResponse> {
        const startTime = Date.now();
        const [owner, repo] = this.parseRepoName(repoFullName);
        this.logger.log(`🔍 Starting enhanced analysis for: ${owner}/${repo}`);

        try {
            // Get full analysis first
            const fullAnalysis = await this.analyzeRepository(userToken, repoFullName);

            // Check for critical files
            const criticalFiles = await this.checkCriticalFiles(owner, repo, userToken);

            // Build abstracted summary
            const summary = this.buildAbstractedSummary(
                repoFullName,
                fullAnalysis,
                criticalFiles,
            );

            // Build actionable items
            const actionableItems = this.buildActionableItems(criticalFiles);

            const duration = Date.now() - startTime;
            this.logger.log(`✅ Enhanced analysis complete in ${duration}ms`);

            return {
                success: true,
                repo_analysis_summary: summary,
                actionable_items: actionableItems,
                duration: `${duration}ms`,
            };
        } catch (error) {
            this.logger.error(`❌ Enhanced analysis failed: ${(error as Error).message}`);
            throw new InternalServerErrorException(
                `Enhanced analysis failed: ${(error as Error).message}`,
            );
        }
    }

    /**
     * Check for critical files (Dockerfile, .dockerignore, README)
     */
    private async checkCriticalFiles(
        owner: string,
        repo: string,
        userToken: string,
    ): Promise<{ dockerfile: boolean; dockerignore: boolean; readme: boolean }> {
        const repoContents = await this.getRepoContents(owner, repo, userToken);
        const fileNames = repoContents.map((f) => f.name.toLowerCase());

        return {
            dockerfile: fileNames.some((n) => n === 'dockerfile'),
            dockerignore: fileNames.some((n) => n === '.dockerignore'),
            readme: fileNames.some((n) =>
                ['readme.md', 'readme', 'readme.txt', 'readme.rst'].includes(n),
            ),
        };
    }

    /**
     * Build abstracted summary for frontend consumption
     */
    private buildAbstractedSummary(
        repoFullName: string,
        analysis: RepositoryAnalysis,
        criticalFiles: { dockerfile: boolean; dockerignore: boolean; readme: boolean },
    ): RepoAnalysisSummary {
        // Determine suggested runtime based on detected language and version
        const suggestedRuntime = this.determineSuggestedRuntime(analysis);

        // Get primary framework
        const detectedFramework =
            analysis.detected.frameworks.length > 0
                ? analysis.detected.frameworks[0]
                : null;

        return {
            repository_name: repoFullName,
            has_dockerfile: criticalFiles.dockerfile,
            has_dockerignore: criticalFiles.dockerignore,
            has_readme: criticalFiles.readme,
            detected_ports: analysis.detected.ports,
            suggested_runtime: suggestedRuntime,
            detected_framework: detectedFramework,
        };
    }

    /**
     * Determine the suggested Docker base image runtime
     */
    private determineSuggestedRuntime(analysis: RepositoryAnalysis): string | null {
        const lang = analysis.detected.language?.toLowerCase();
        const runtime = analysis.detected.runtime;

        if (!lang) return null;

        switch (lang) {
            case 'typescript':
            case 'javascript':
                const nodeVer = runtime.nodeVersion || '20';
                return `node:${nodeVer}-alpine`;
            case 'python':
                const pyVer = runtime.pythonVersion || '3.11';
                return `python:${pyVer}-slim`;
            case 'java':
            case 'kotlin':
                const javaVer = runtime.javaVersion || '21';
                return `eclipse-temurin:${javaVer}-jre-alpine`;
            case 'go':
                const goVer = runtime.goVersion || '1.21';
                return `golang:${goVer}-alpine`;
            case 'rust':
                return 'rust:1.75-alpine';
            case 'ruby':
                return 'ruby:3.2-alpine';
            case 'php':
                return 'php:8.2-fpm-alpine';
            default:
                return null;
        }
    }

    /**
     * Build actionable items for the frontend
     */
    private buildActionableItems(
        criticalFiles: { dockerfile: boolean; dockerignore: boolean; readme: boolean },
    ): ActionableItem[] {
        return [
            {
                item: 'dockerfile',
                is_present: criticalFiles.dockerfile,
                action_required: !criticalFiles.dockerfile,
                frontend_component: 'GenerateDockerButton',
            },
            {
                item: 'dockerignore',
                is_present: criticalFiles.dockerignore,
                action_required: !criticalFiles.dockerignore,
                frontend_component: 'GenerateDockerignoreButton',
            },
            {
                item: 'readme',
                is_present: criticalFiles.readme,
                action_required: !criticalFiles.readme,
                frontend_component: 'GenerateReadmeButton',
            },
        ];
    }

    // ==================== DOCKERFILE GENERATION ====================

    /**
     * Generate and commit a Dockerfile to the repository using MCP
     */
    async generateDockerfile(
        userToken: string,
        repoFullName: string,
        branch?: string,
    ): Promise<DockerfileGenerationResponse> {
        const [owner, repo] = this.parseRepoName(repoFullName);
        this.logger.log(`🐳 Generating Dockerfile for: ${owner}/${repo}`);

        let client: Client | null = null;
        let transport: StdioClientTransport | null = null;

        try {
            // First, perform deep code analysis
            const deepAnalysis = await this.performDeepCodeAnalysis(userToken, repoFullName);
            this.logger.log(`📊 Deep analysis complete: ${deepAnalysis.language} / ${deepAnalysis.framework}`);

            // Generate Dockerfile content
            const dockerfileContent = this.generateDockerfileContent(deepAnalysis);
            this.logger.log('📝 Dockerfile content generated');

            // Connect to MCP server
            client = new Client({ name: 'mcp-dockerfile-generator', version: '1.0.0' });
            transport = new StdioClientTransport({
                command: 'npx',
                args: ['-y', '@modelcontextprotocol/server-github'],
                env: { ...process.env, GITHUB_PERSONAL_ACCESS_TOKEN: userToken },
            });

            await client.connect(transport);
            this.logger.log('✅ Connected to GitHub MCP server for file creation');

            // Get default branch if not specified
            const targetBranch = branch || await this.getDefaultBranch(owner, repo, userToken);

            // Use create_or_update_file MCP tool
            const result = await client.callTool({
                name: 'create_or_update_file',
                arguments: {
                    owner,
                    repo,
                    path: 'Dockerfile',
                    content: dockerfileContent,
                    message: '🐳 Add Dockerfile (auto-generated by MCP Analyzer)',
                    branch: targetBranch,
                },
            });

            this.logger.log('✅ Dockerfile created successfully via MCP');

            return {
                operation: 'dockerfile_generation',
                status: 'success',
                generated_file_path: '/Dockerfile',
                confirmation_tick: true,
                dockerfile_content: dockerfileContent,
            };
        } catch (error) {
            this.logger.error(`❌ Dockerfile generation failed: ${(error as Error).message}`);

            return {
                operation: 'dockerfile_generation',
                status: 'failed',
                generated_file_path: '/Dockerfile',
                confirmation_tick: false,
                error_message: (error as Error).message,
            };
        } finally {
            if (client) {
                try {
                    await client.close();
                    this.logger.log('🧹 MCP subprocess cleaned up');
                } catch { }
            }
        }
    }

    /**
     * Get the default branch for a repository
     */
    private async getDefaultBranch(owner: string, repo: string, userToken: string): Promise<string> {
        try {
            const response = await axios.get(`https://api.github.com/repos/${owner}/${repo}`, {
                headers: {
                    Authorization: `Bearer ${userToken}`,
                    Accept: 'application/vnd.github.v3+json',
                },
            });
            return response.data.default_branch || 'main';
        } catch {
            return 'main';
        }
    }

    /**
     * Perform deep code analysis for Dockerfile generation
     */
    private async performDeepCodeAnalysis(
        userToken: string,
        repoFullName: string,
    ): Promise<DeepCodeAnalysis> {
        const [owner, repo] = this.parseRepoName(repoFullName);

        // Get full repository analysis
        const analysis = await this.analyzeRepository(userToken, repoFullName);

        // Determine language and version
        const language = analysis.detected.language || 'unknown';
        const runtime = analysis.detected.runtime;
        const files = analysis.files;

        // Initialize deep analysis result
        const deepAnalysis: DeepCodeAnalysis = {
            language,
            languageVersion: null,
            packageManager: null,
            dependencyFile: null,
            entryPoint: null,
            buildCommand: null,
            startCommand: null,
            staticAssetDir: null,
            framework: analysis.detected.frameworks[0] || null,
            baseImage: 'alpine',
            workdir: '/app',
            exposedPorts: analysis.detected.ports,
        };

        // Language-specific deep analysis
        switch (language.toLowerCase()) {
            case 'typescript':
            case 'javascript':
                this.analyzeNodeProject(files, deepAnalysis);
                break;
            case 'python':
                this.analyzePythonProject(files, deepAnalysis);
                break;
            case 'java':
            case 'kotlin':
                this.analyzeJavaProject(files, deepAnalysis);
                break;
            case 'go':
                this.analyzeGoProject(files, deepAnalysis);
                break;
            case 'rust':
                this.analyzeRustProject(files, deepAnalysis);
                break;
            default:
                this.logger.warn(`Unknown language: ${language}, using defaults`);
        }

        return deepAnalysis;
    }

    /**
     * Analyze Node.js/TypeScript project specifics
     */
    private analyzeNodeProject(files: Record<string, string>, analysis: DeepCodeAnalysis): void {
        const pkg = files['package.json'];
        if (!pkg) return;

        try {
            const parsed = JSON.parse(pkg);

            // Detect package manager
            if (files['pnpm-lock.yaml']) {
                analysis.packageManager = 'pnpm';
            } else if (files['yarn.lock']) {
                analysis.packageManager = 'yarn';
            } else {
                analysis.packageManager = 'npm';
            }

            analysis.dependencyFile = 'package.json';

            // Detect Node version
            if (files['.nvmrc']) {
                analysis.languageVersion = files['.nvmrc'].trim();
            } else if (parsed.engines?.node) {
                const match = parsed.engines.node.match(/(\d+)/);
                analysis.languageVersion = match ? match[1] : '20';
            } else {
                analysis.languageVersion = '20';
            }

            // Detect entry point
            analysis.entryPoint = parsed.main || 'index.js';
            if (files['tsconfig.json']) {
                analysis.entryPoint = 'dist/main.js';
            }

            // Detect scripts
            if (parsed.scripts) {
                analysis.buildCommand = parsed.scripts.build ? `${analysis.packageManager} run build` : null;
                analysis.startCommand = parsed.scripts.start
                    ? `${analysis.packageManager} run start`
                    : parsed.scripts['start:prod']
                        ? `${analysis.packageManager} run start:prod`
                        : `node ${analysis.entryPoint}`;
            }

            // Set base image
            analysis.baseImage = `node:${analysis.languageVersion}-alpine`;

            // Default port if not detected
            if (analysis.exposedPorts.length === 0) {
                analysis.exposedPorts = ['3000'];
            }
        } catch { }
    }

    /**
     * Analyze Python project specifics
     */
    private analyzePythonProject(files: Record<string, string>, analysis: DeepCodeAnalysis): void {
        // Detect package manager and dependency file
        if (files['pyproject.toml']) {
            if (files['poetry.lock']) {
                analysis.packageManager = 'poetry';
            } else if (files['pdm.lock']) {
                analysis.packageManager = 'pdm';
            } else {
                analysis.packageManager = 'pip';
            }
            analysis.dependencyFile = 'pyproject.toml';
        } else if (files['Pipfile']) {
            analysis.packageManager = 'pipenv';
            analysis.dependencyFile = 'Pipfile';
        } else if (files['requirements.txt']) {
            analysis.packageManager = 'pip';
            analysis.dependencyFile = 'requirements.txt';
        }

        // Detect Python version
        if (files['runtime.txt']) {
            const match = files['runtime.txt'].match(/python-(\d+\.\d+)/);
            analysis.languageVersion = match ? match[1] : '3.11';
        } else {
            analysis.languageVersion = '3.11';
        }

        // Detect entry point and framework
        const framework = analysis.framework?.toLowerCase();
        if (framework === 'django') {
            analysis.entryPoint = 'manage.py';
            analysis.startCommand = 'gunicorn --bind 0.0.0.0:8000 project.wsgi:application';
            analysis.exposedPorts = ['8000'];
        } else if (framework === 'fastapi') {
            analysis.entryPoint = 'main.py';
            analysis.startCommand = 'uvicorn main:app --host 0.0.0.0 --port 8000';
            analysis.exposedPorts = ['8000'];
        } else if (framework === 'flask') {
            analysis.entryPoint = 'app.py';
            analysis.startCommand = 'gunicorn --bind 0.0.0.0:5000 app:app';
            analysis.exposedPorts = ['5000'];
        } else {
            analysis.entryPoint = 'main.py';
            analysis.startCommand = 'python main.py';
        }

        analysis.baseImage = `python:${analysis.languageVersion}-slim`;
    }

    /**
     * Analyze Java project specifics
     */
    private analyzeJavaProject(files: Record<string, string>, analysis: DeepCodeAnalysis): void {
        if (files['pom.xml']) {
            analysis.packageManager = 'maven';
            analysis.dependencyFile = 'pom.xml';
            analysis.buildCommand = 'mvn clean package -DskipTests';

            // Extract Java version from pom.xml
            const javaVersionMatch = files['pom.xml'].match(/<java.version>(\d+)<\/java.version>/);
            analysis.languageVersion = javaVersionMatch ? javaVersionMatch[1] : '21';
        } else if (files['build.gradle'] || files['build.gradle.kts']) {
            analysis.packageManager = 'gradle';
            analysis.dependencyFile = files['build.gradle'] ? 'build.gradle' : 'build.gradle.kts';
            analysis.buildCommand = './gradlew build -x test';
            analysis.languageVersion = '21';
        }

        // Detect Spring Boot
        const isSpringBoot = analysis.framework === 'Spring Boot';
        if (isSpringBoot) {
            analysis.entryPoint = 'target/*.jar';
            analysis.startCommand = 'java -jar app.jar';
            analysis.exposedPorts = analysis.exposedPorts.length > 0 ? analysis.exposedPorts : ['8080'];
        } else {
            analysis.startCommand = 'java -jar app.jar';
            analysis.exposedPorts = ['8080'];
        }

        analysis.baseImage = `eclipse-temurin:${analysis.languageVersion}-jre-alpine`;
    }

    /**
     * Analyze Go project specifics
     */
    private analyzeGoProject(files: Record<string, string>, analysis: DeepCodeAnalysis): void {
        analysis.packageManager = 'go modules';
        analysis.dependencyFile = 'go.mod';

        if (files['go.mod']) {
            const versionMatch = files['go.mod'].match(/go\s+(\d+\.\d+)/);
            analysis.languageVersion = versionMatch ? versionMatch[1] : '1.21';
        }

        analysis.entryPoint = 'main.go';
        analysis.buildCommand = 'go build -o app .';
        analysis.startCommand = './app';
        analysis.baseImage = `golang:${analysis.languageVersion}-alpine`;
        analysis.exposedPorts = analysis.exposedPorts.length > 0 ? analysis.exposedPorts : ['8080'];
    }

    /**
     * Analyze Rust project specifics
     */
    private analyzeRustProject(files: Record<string, string>, analysis: DeepCodeAnalysis): void {
        analysis.packageManager = 'cargo';
        analysis.dependencyFile = 'Cargo.toml';
        analysis.entryPoint = 'src/main.rs';
        analysis.buildCommand = 'cargo build --release';
        analysis.startCommand = './target/release/app';
        analysis.languageVersion = '1.75';
        analysis.baseImage = 'rust:1.75-alpine';
        analysis.exposedPorts = analysis.exposedPorts.length > 0 ? analysis.exposedPorts : ['8080'];
    }

    /**
     * Generate Dockerfile content based on deep analysis
     */
    private generateDockerfileContent(analysis: DeepCodeAnalysis): string {
        const lang = analysis.language.toLowerCase();

        switch (lang) {
            case 'typescript':
            case 'javascript':
                return this.generateNodeDockerfile(analysis);
            case 'python':
                return this.generatePythonDockerfile(analysis);
            case 'java':
            case 'kotlin':
                return this.generateJavaDockerfile(analysis);
            case 'go':
                return this.generateGoDockerfile(analysis);
            case 'rust':
                return this.generateRustDockerfile(analysis);
            default:
                return this.generateGenericDockerfile(analysis);
        }
    }

    /**
     * Generate Node.js Dockerfile
     */
    private generateNodeDockerfile(analysis: DeepCodeAnalysis): string {
        const pm = analysis.packageManager || 'npm';
        const installCmd = pm === 'pnpm' ? 'pnpm install --frozen-lockfile'
            : pm === 'yarn' ? 'yarn install --frozen-lockfile'
                : 'npm ci --only=production';
        const devInstallCmd = pm === 'pnpm' ? 'pnpm install --frozen-lockfile'
            : pm === 'yarn' ? 'yarn install --frozen-lockfile'
                : 'npm ci';
        const port = analysis.exposedPorts[0] || '3000';

        const hasBuild = !!analysis.buildCommand;

        let dockerfile = `# ============================================
# Auto-generated Dockerfile by MCP Analyzer
# Stack: ${analysis.language} / ${analysis.framework || 'Node.js'}
# ============================================

# Build stage
FROM ${analysis.baseImage} AS builder

WORKDIR ${analysis.workdir}

# Install dependencies for building (if needed)
${pm === 'pnpm' ? 'RUN corepack enable && corepack prepare pnpm@latest --activate\n' : ''}
# Copy dependency files
COPY package*.json ${pm === 'pnpm' ? 'pnpm-lock.yaml* ' : pm === 'yarn' ? 'yarn.lock* ' : ''}./

# Install all dependencies (including dev for building)
RUN ${devInstallCmd}

# Copy source code
COPY . .
`;

        if (hasBuild) {
            dockerfile += `
# Build the application
RUN ${analysis.buildCommand}

# Production stage
FROM ${analysis.baseImage} AS production

WORKDIR ${analysis.workdir}

${pm === 'pnpm' ? 'RUN corepack enable && corepack prepare pnpm@latest --activate\n' : ''}
# Copy dependency files
COPY package*.json ${pm === 'pnpm' ? 'pnpm-lock.yaml* ' : pm === 'yarn' ? 'yarn.lock* ' : ''}./

# Install production dependencies only
RUN ${installCmd}

# Copy built application from builder stage
COPY --from=builder ${analysis.workdir}/dist ./dist

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001
USER nodejs

EXPOSE ${port}

CMD ["node", "dist/main.js"]
`;
        } else {
            dockerfile += `
# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001
USER nodejs

EXPOSE ${port}

CMD ${JSON.stringify(analysis.startCommand?.split(' ') || ['node', 'index.js'])}
`;
        }

        return dockerfile;
    }

    /**
     * Generate Python Dockerfile
     */
    private generatePythonDockerfile(analysis: DeepCodeAnalysis): string {
        const port = analysis.exposedPorts[0] || '8000';
        const pm = analysis.packageManager || 'pip';

        let installCmd: string;
        if (pm === 'poetry') {
            installCmd = `pip install poetry && poetry config virtualenvs.create false && poetry install --no-dev --no-interaction`;
        } else if (pm === 'pipenv') {
            installCmd = `pip install pipenv && pipenv install --system --deploy`;
        } else {
            installCmd = `pip install --no-cache-dir -r requirements.txt`;
        }

        return `# ============================================
# Auto-generated Dockerfile by MCP Analyzer
# Stack: Python / ${analysis.framework || 'Python Application'}
# ============================================

FROM ${analysis.baseImage}

WORKDIR ${analysis.workdir}

# Prevent Python from writing bytecode and buffering stdout/stderr
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \\
    gcc \\
    && rm -rf /var/lib/apt/lists/*

# Copy dependency files
COPY ${analysis.dependencyFile || 'requirements.txt'} .
${pm === 'poetry' ? 'COPY poetry.lock* .' : ''}
${pm === 'pipenv' ? 'COPY Pipfile.lock* .' : ''}

# Install Python dependencies
RUN ${installCmd}

# Copy source code
COPY . .

# Create non-root user for security
RUN useradd --create-home --shell /bin/bash appuser
USER appuser

EXPOSE ${port}

CMD ${JSON.stringify(analysis.startCommand?.split(' ') || ['python', 'main.py'])}
`;
    }

    /**
     * Generate Java Dockerfile
     */
    private generateJavaDockerfile(analysis: DeepCodeAnalysis): string {
        const port = analysis.exposedPorts[0] || '8080';
        const isMaven = analysis.packageManager === 'maven';

        return `# ============================================
# Auto-generated Dockerfile by MCP Analyzer
# Stack: Java / ${analysis.framework || 'Java Application'}
# ============================================

# Build stage
FROM ${isMaven ? 'maven:3.9-eclipse-temurin-' + analysis.languageVersion : 'gradle:8-jdk' + analysis.languageVersion} AS builder

WORKDIR ${analysis.workdir}

# Copy dependency files
COPY ${analysis.dependencyFile || 'pom.xml'} .
${isMaven ? '' : 'COPY settings.gradle* .\nCOPY gradle* ./gradle/'}

# Download dependencies (cached layer)
RUN ${isMaven ? 'mvn dependency:go-offline' : './gradlew dependencies --no-daemon'}

# Copy source code
COPY src ./src

# Build the application
RUN ${analysis.buildCommand || (isMaven ? 'mvn clean package -DskipTests' : './gradlew build -x test')}

# Production stage
FROM ${analysis.baseImage}

WORKDIR ${analysis.workdir}

# Copy the built jar
COPY --from=builder ${analysis.workdir}/target/*.jar app.jar

# Create non-root user for security
RUN addgroup -g 1001 -S javauser && adduser -S javauser -u 1001 -G javauser
USER javauser

EXPOSE ${port}

# JVM tuning for containers
ENV JAVA_OPTS="-XX:+UseContainerSupport -XX:MaxRAMPercentage=75.0"

ENTRYPOINT ["sh", "-c", "java $JAVA_OPTS -jar app.jar"]
`;
    }

    /**
     * Generate Go Dockerfile
     */
    private generateGoDockerfile(analysis: DeepCodeAnalysis): string {
        const port = analysis.exposedPorts[0] || '8080';

        return `# ============================================
# Auto-generated Dockerfile by MCP Analyzer
# Stack: Go / ${analysis.framework || 'Go Application'}
# ============================================

# Build stage
FROM ${analysis.baseImage} AS builder

WORKDIR ${analysis.workdir}

# Copy dependency files
COPY go.mod go.sum* ./

# Download dependencies
RUN go mod download

# Copy source code
COPY . .

# Build the application with optimizations
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-w -s" -o app .

# Production stage - minimal image
FROM scratch

WORKDIR /

# Copy the binary from builder
COPY --from=builder ${analysis.workdir}/app .

# Copy CA certificates for HTTPS
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/

EXPOSE ${port}

ENTRYPOINT ["/app"]
`;
    }

    /**
     * Generate Rust Dockerfile
     */
    private generateRustDockerfile(analysis: DeepCodeAnalysis): string {
        const port = analysis.exposedPorts[0] || '8080';

        return `# ============================================
# Auto-generated Dockerfile by MCP Analyzer
# Stack: Rust / ${analysis.framework || 'Rust Application'}
# ============================================

# Build stage
FROM ${analysis.baseImage} AS builder

WORKDIR ${analysis.workdir}

# Copy dependency files
COPY Cargo.toml Cargo.lock* ./

# Create dummy main.rs to build dependencies
RUN mkdir src && echo "fn main() {}" > src/main.rs
RUN cargo build --release && rm -rf src

# Copy actual source code
COPY . .

# Build the application
RUN cargo build --release

# Production stage - minimal image
FROM alpine:latest

RUN apk add --no-cache ca-certificates

WORKDIR /

# Copy the binary from builder
COPY --from=builder ${analysis.workdir}/target/release/* ./app

EXPOSE ${port}

CMD ["./app"]
`;
    }

    /**
     * Generate generic Dockerfile for unknown languages
     */
    private generateGenericDockerfile(analysis: DeepCodeAnalysis): string {
        const port = analysis.exposedPorts[0] || '8080';

        return `# ============================================
# Auto-generated Dockerfile by MCP Analyzer
# Stack: ${analysis.language || 'Unknown'}
# ============================================

FROM alpine:latest

WORKDIR /app

# Copy all files
COPY . .

EXPOSE ${port}

# Replace with actual start command
CMD ["echo", "Please configure the start command"]
`;
    }
}

// Type Definitions
interface RepoFile {
    type: 'file' | 'dir';
    name: string;
    path: string;
    size: number;
    sha: string;
    url: string;
    download_url: string | null;
}

export interface RepositoryAnalysis {
    repository: { owner: string; repo: string };
    detected: {
        language: string | null;
        frameworks: string[];
        databases: string[];
        runtime: {
            nodeVersion?: string;
            pythonVersion?: string;
            goVersion?: string;
            javaVersion?: string;
        };
        buildConfig: {
            name?: string;
            version?: string;
            description?: string;
            scripts?: Record<string, string>;
            engines?: Record<string, string>;
        };
        ports: string[];
        envVars: string[];
        docker: {
            exists: boolean;
            baseImage?: string | null;
            exposedPorts?: string[];
            workdir?: string | null;
            cmd?: string | null;
            composeServices?: string[];
        } | null;
        cicd: {
            platform: string;
            configured: boolean;
        } | null;
    };
    missing: string[];
    files: Record<string, string>;
    rawData: Record<string, any>;
}
