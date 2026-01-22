import { Injectable, Logger, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import axios from 'axios';

/**
 * McpService - Smart Repository Analysis with Gitignore Exclusion
 * 
 * Features:
 * - Uses search_code but excludes .gitignore patterns
 * - Dynamic detection (no hardcoded language checks)
 * - Returns structured JSON with detected/missing fields
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
