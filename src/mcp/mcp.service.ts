import { Injectable, Logger, BadRequestException, Inject, forwardRef } from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import axios from 'axios';
import {
    SmartAnalysisResult,
    SmartAnalysisResponse,
    FetchedFiles,
    DockerfileGenerationResponse,
} from './dto/smart-analysis.dto';
import { GeminiService } from '../gemini/gemini.service';

/**
 * McpService - Smart Repository Analysis with Context Locking
 * 
 * Features:
 * - Context-locked analysis (repo + branch)
 * - Uses MCP tools for file fetching and code search
 * - LLM-powered analysis via GeminiService (zero hardcoding)
 * - Dockerfile detection using search_code (finds anywhere in repo)
 * - Dockerfile generation and push to repository
 * 
 * MCP Tools Used:
 * - get_file_contents: Read files and directories
 * - search_code: Find Dockerfiles anywhere in repo
 * - create_or_update_file: Push generated Dockerfile
 */
@Injectable()
export class McpService {
    private readonly logger = new Logger(McpService.name);

    constructor(
        @Inject(forwardRef(() => GeminiService))
        private readonly geminiService: GeminiService,
    ) { }

    // ==================== SMART ANALYSIS (Context Locked) ====================

    /**
     * Smart repository analysis with context locking
     * Uses MCP tools + LLM for intelligent, zero-hardcoding extraction
     * 
     * @param token - GitHub personal access token
     * @param repository - Repository in "owner/repo" format (CONTEXT LOCK 1)
     * @param branch - Branch name to analyze (CONTEXT LOCK 2)
     */
    async smartAnalyze(
        token: string,
        repository: string,
        branch: string,
    ): Promise<SmartAnalysisResponse> {
        const startTime = Date.now();
        const [owner, repo] = this.parseRepoName(repository);

        this.logger.log(`🧠 Smart analysis starting for: ${owner}/${repo} @ ${branch}`);
        this.logger.log(`🔒 Context locked to repository: ${repository}, branch: ${branch}`);

        let client: Client | null = null;

        try {
            // Create MCP client
            client = await this.createMcpClient(token);
            this.logger.log('✅ MCP client connected');

            // Step 1: Get root directory listing (context-locked to repo + branch)
            const rootFiles = await this.mcpGetDirectoryContents(client, owner, repo, '', branch, token);
            this.logger.log(`📂 Found ${rootFiles.length} items in root directory`);

            // Step 2: Identify and fetch manifest files
            const manifestFiles = this.identifyKeyFiles(rootFiles);
            this.logger.log(`📋 Identified ${manifestFiles.length} key files to analyze`);

            // Step 3: Fetch file contents via MCP (context-locked)
            const fileContents = await this.fetchFilesViaMcp(client, owner, repo, branch, manifestFiles, token);
            this.logger.log(`📄 Fetched ${Object.keys(fileContents).length} file contents`);

            // DEBUG: Log fetched file names and sizes
            this.logger.debug(`📦 Fetched files: ${Object.keys(fileContents).join(', ')}`);
            for (const [fileName, content] of Object.entries(fileContents)) {
                this.logger.debug(`   📄 ${fileName}: ${content.length} chars`);
            }

            // Step 4: Search for Dockerfile using search_code (finds anywhere in repo)
            const dockerfileLocation = await this.searchForDockerfile(client, owner, repo, branch, token);
            
            // Step 5: Send to Gemini for LLM analysis
            const analysis = await this.geminiService.analyzeFiles(repository, branch, fileContents);
            
            // Override Dockerfile detection with search_code result (more accurate)
            if (dockerfileLocation) {
                analysis.is_docker_present = true;
                analysis.dockerfile_location = dockerfileLocation;
                this.logger.log(`🐳 Dockerfile found at: ${dockerfileLocation}`);
            } else {
                analysis.is_docker_present = false;
                analysis.dockerfile_location = null;
                this.logger.log(`🐳 No Dockerfile found in repository`);
            }

            const duration = Date.now() - startTime;
            this.logger.log(`✅ Smart analysis complete in ${duration}ms`);

            return {
                success: true,
                repository,
                branch,
                duration: `${duration}ms`,
                analysis,
            };
        } catch (error) {
            const duration = Date.now() - startTime;
            this.logger.error(`❌ Smart analysis failed: ${(error as Error).message}`);

            return {
                success: false,
                repository,
                branch,
                duration: `${duration}ms`,
                analysis: this.getEmptyAnalysis(),
                error: (error as Error).message,
            };
        } finally {
            if (client) {
                try {
                    await client.close();
                    this.logger.log('🧹 MCP client closed');
                } catch { }
            }
        }
    }

    /**
     * Create MCP client connected to GitHub server
     */
    private async createMcpClient(token: string): Promise<Client> {
        const client = new Client({ name: 'mcp-smart-analyzer', version: '2.0.0' });

        const transport = new StdioClientTransport({
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-github'],
            env: { ...process.env, GITHUB_PERSONAL_ACCESS_TOKEN: token },
        });

        await client.connect(transport);
        return client;
    }

    /**
     * Get directory contents using MCP get_file_contents tool
     * CONTEXT LOCKED: Uses owner, repo, and branch parameters
     */
    private async mcpGetDirectoryContents(
        client: Client,
        owner: string,
        repo: string,
        path: string,
        branch: string,
        token?: string,
    ): Promise<Array<{ name: string; type: string; path: string }>> {
        try {
            const result = await client.callTool({
                name: 'get_file_contents',
                arguments: {
                    owner,      // CONTEXT LOCK: Repository owner
                    repo,       // CONTEXT LOCK: Repository name
                    path: path || '',
                    branch,     // CONTEXT LOCK: Specific branch
                },
            });

            if (result?.content && Array.isArray(result.content)) {
                const textContent = result.content.find((c: any) => c.type === 'text');
                if (textContent?.text) {
                    try {
                        // Try to parse as JSON array (directory listing)
                        const parsed = JSON.parse(textContent.text);
                        if (Array.isArray(parsed)) {
                            // Filter out malformed items (submodules, symlinks with null URLs)
                            return parsed
                                .filter((item: any) => item && item.name && item.type && item.path)
                                .map((item: any) => ({
                                    name: item.name,
                                    type: item.type,
                                    path: item.path,
                                }));
                        }
                    } catch {
                        // Not a directory, return empty
                        return [];
                    }
                }
            }
            return [];
        } catch (error) {
            this.logger.warn(`MCP directory fetch failed for ${path}: ${(error as Error).message}`);
            // Fallback to GitHub API with authentication
            return this.getRepoContentsViaApi(owner, repo, path, branch, token);
        }
    }

    /**
     * Fallback: Get repo contents via GitHub API with authentication
     */
    private async getRepoContentsViaApi(
        owner: string,
        repo: string,
        path: string,
        branch: string,
        token?: string,
    ): Promise<Array<{ name: string; type: string; path: string }>> {
        try {
            const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`;
            const headers: Record<string, string> = {
                Accept: 'application/vnd.github.v3+json',
            };
            if (token) {
                headers.Authorization = `Bearer ${token}`;
            }
            const response = await axios.get(url, { headers });

            if (Array.isArray(response.data)) {
                return response.data.map((item: any) => ({
                    name: item.name,
                    type: item.type,
                    path: item.path,
                }));
            }
            return [];
        } catch {
            return [];
        }
    }

    /**
     * Identify key manifest/config files from directory listing
     * This is a minimal list - LLM will understand any file
     */
    private identifyKeyFiles(files: Array<{ name: string; type: string; path: string }>): string[] {
        const keyPatterns = [
            // Primary manifest files (essential)
            'package.json',
            'requirements.txt',
            'pyproject.toml',
            'pom.xml',
            'build.gradle',
            'go.mod',
            'Cargo.toml',
            'Gemfile',
            'composer.json',
            // Version files
            '.nvmrc',
            '.node-version',
            '.python-version',
            'runtime.txt',
            // Docker files
            'Dockerfile',
            'docker-compose.yml',
            'docker-compose.yaml',
            // Environment
            '.env.example',
            '.env.sample',
            '.env.template',
            // Documentation
            'README.md',
            // TypeScript config (helps detect Node.js version)
            'tsconfig.json',
        ];

        return files
            .filter(f => f.type === 'file' && keyPatterns.some(p =>
                f.name.toLowerCase() === p.toLowerCase()
            ))
            .map(f => f.path);
    }

    /**
     * Fetch multiple files via MCP with context locking
     */
    private async fetchFilesViaMcp(
        client: Client,
        owner: string,
        repo: string,
        branch: string,
        filePaths: string[],
        token?: string,
    ): Promise<FetchedFiles> {
        const result: FetchedFiles = {};

        this.logger.debug(`📂 Fetching ${filePaths.length} files: ${filePaths.join(', ')}`);

        for (const filePath of filePaths) {
            try {
                const content = await this.mcpGetFileContent(client, owner, repo, filePath, branch, token);
                if (content) {
                    const fileName = filePath.split('/').pop() || filePath;
                    result[fileName] = content;
                    this.logger.debug(`✅ Fetched ${fileName}: ${content.length} chars`);
                } else {
                    this.logger.warn(`⚠️ Empty content for ${filePath}`);
                }
            } catch (error) {
                this.logger.warn(`Failed to fetch ${filePath}: ${(error as Error).message}`);
            }
        }

        this.logger.debug(`📦 Total files fetched: ${Object.keys(result).length}`);
        return result;
    }

    /**
     * Get single file content using MCP tool
     * CONTEXT LOCKED: Uses owner, repo, path, and branch parameters
     */
    private async mcpGetFileContent(
        client: Client,
        owner: string,
        repo: string,
        path: string,
        branch: string,
        token?: string,
    ): Promise<string | null> {
        try {
            this.logger.debug(`📥 Fetching file via MCP: ${path}`);
            
            const result = await client.callTool({
                name: 'get_file_contents',
                arguments: {
                    owner,      // CONTEXT LOCK
                    repo,       // CONTEXT LOCK
                    path,       // Specific file path
                    branch,     // CONTEXT LOCK
                },
            });

            this.logger.debug(`📦 MCP raw result type: ${typeof result}`);
            this.logger.debug(`📦 MCP result keys: ${result ? Object.keys(result).join(', ') : 'null'}`);
            this.logger.debug(`📦 MCP response: ${JSON.stringify(result).substring(0, 500)}`);

            if (result?.content && Array.isArray(result.content)) {
                this.logger.debug(`📦 Content array length: ${result.content.length}`);
                
                const textContent = result.content.find((c: any) => c.type === 'text');
                this.logger.debug(`📦 Text content found: ${textContent ? 'yes' : 'no'}`);
                
                if (textContent?.text) {
                    const rawText = textContent.text;
                    this.logger.debug(`📄 Raw text (first 300 chars): ${rawText.substring(0, 300)}`);
                    
                    // Try to parse as JSON (MCP might wrap content in JSON)
                    try {
                        const parsed = JSON.parse(rawText);
                        this.logger.debug(`📦 Parsed successfully. Keys: ${typeof parsed === 'object' ? Object.keys(parsed).join(', ') : 'not object'}`);
                        
                        // Case 1: Base64 encoded content (GitHub API format)
                        // NOTE: MCP GitHub server may return already-decoded content but still include encoding: 'base64'
                        if (parsed.content && parsed.encoding === 'base64') {
                            const content = parsed.content;
                            
                            // Check if content looks like actual base64 (only A-Za-z0-9+/= chars, no spaces/newlines in the data itself)
                            // Real base64 doesn't have spaces, curly braces, or typical text characters
                            const looksLikeBase64 = /^[A-Za-z0-9+/=\n\r]+$/.test(content) && !content.includes('{') && !content.includes('<');
                            
                            if (looksLikeBase64) {
                                // Actual base64 - decode it
                                this.logger.debug(`🔍 Content is base64 encoded, decoding...`);
                                const cleanBase64 = content.replace(/[\n\r\s]/g, '');
                                const decoded = Buffer.from(cleanBase64, 'base64').toString('utf-8');
                                this.logger.debug(`✅ Decoded base64 for ${path}: ${decoded.length} chars`);
                                return decoded;
                            } else {
                                // Already plain text - MCP server pre-decoded it
                                this.logger.debug(`✅ Content already plain text for ${path}: ${content.length} chars`);
                                return content;
                            }
                        }
                        
                        // Case 2: Direct content property (string)
                        if (typeof parsed.content === 'string') {
                            this.logger.debug(`✅ Direct content for ${path}: ${parsed.content.length} chars`);
                            return parsed.content;
                        }
                        
                        // Case 3: The parsed object IS the file content (e.g., package.json)
                        // This happens when MCP returns the file as-is and it's valid JSON
                        if (typeof parsed === 'object' && !Array.isArray(parsed)) {
                            this.logger.debug(`✅ File is JSON object for ${path}, returning original text`);
                            return rawText; // Return the original JSON string
                        }
                        
                        // Case 4: Array (could be directory listing, skip)
                        if (Array.isArray(parsed)) {
                            this.logger.debug(`⚠️ Got array, likely directory listing, skipping`);
                            return null;
                        }
                        
                    } catch {
                        // Not JSON - this IS the raw file content (e.g., README.md, .env)
                        this.logger.debug(`✅ Not JSON, raw text content for ${path}: ${rawText.length} chars`);
                        return rawText;
                    }
                    
                    // Fallback: return raw text if nothing else matched
                    this.logger.debug(`⚠️ No case matched, returning raw text`);
                    return rawText;
                }
            }
            
            this.logger.warn(`⚠️ No content found in MCP response for ${path}`);
            // Fallback to GitHub API
            return this.fetchFileViaApi(owner, repo, path, branch, token);
            
        } catch (error) {
            this.logger.warn(`MCP file fetch failed for ${path}: ${(error as Error).message}`);
            // Fallback to direct API with authentication
            return this.fetchFileViaApi(owner, repo, path, branch, token);
        }
    }

    /**
     * Fallback: Fetch file via GitHub API with authentication
     */
    private async fetchFileViaApi(
        owner: string,
        repo: string,
        path: string,
        branch: string,
        token?: string,
    ): Promise<string | null> {
        try {
            this.logger.debug(`📥 Fallback: Fetching ${path} via GitHub API`);
            
            const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`;
            const headers: Record<string, string> = {
                Accept: 'application/vnd.github.v3+json',
            };
            if (token) {
                headers.Authorization = `Bearer ${token}`;
            }
            const response = await axios.get(url, { headers });

            if (response.data.content && response.data.encoding === 'base64') {
                // GitHub API returns base64 with newlines - must strip them before decoding
                const cleanBase64 = response.data.content.replace(/[\n\r\s]/g, '');
                const decoded = Buffer.from(cleanBase64, 'base64').toString('utf-8');
                this.logger.debug(`✅ GitHub API fetched ${path}: ${decoded.length} chars`);
                return decoded;
            }
            
            this.logger.warn(`⚠️ GitHub API returned unexpected format for ${path}`);
            return null;
        } catch (error) {
            this.logger.error(`❌ GitHub API failed for ${path}: ${(error as Error).message}`);
            return null;
        }
    }

    /**
     * Return empty analysis for error cases
     */
    private getEmptyAnalysis(): SmartAnalysisResult {
        return {
            detected_language: 'unknown',
            detected_version: null,
            is_docker_present: false,
            dockerfile_location: null,
            detected_frameworks: [],
            detected_dependencies: [],
            detected_start_cmd: null,
            detected_build_cmd: null,
            env_vars_needed: [],
        };
    }

    /**
     * Parse repository name from "owner/repo" format
     */
    private parseRepoName(repoFullName: string): [string, string] {
        if (!repoFullName || !repoFullName.includes('/')) {
            throw new BadRequestException('Invalid repository format. Use "owner/repo"');
        }
        const [owner, repo] = repoFullName.split('/');
        if (!owner || !repo) throw new BadRequestException('Invalid repository format');
        return [owner, repo];
    }

    // ==================== DOCKERFILE DETECTION (search_code) ====================

    /**
     * Search for Dockerfile anywhere in the repository using MCP search_code
     * This is more accurate than just checking root directory
     * 
     * @returns Dockerfile path if found, null otherwise
     */
    private async searchForDockerfile(
        client: Client,
        owner: string,
        repo: string,
        branch: string,
        token?: string,
    ): Promise<string | null> {
        try {
            // Use MCP search_code to find Dockerfile anywhere in repo
            const result = await client.callTool({
                name: 'search_code',
                arguments: {
                    q: `filename:Dockerfile repo:${owner}/${repo}`,
                    per_page: 10,
                },
            });

            if (result?.content && Array.isArray(result.content)) {
                const textContent = result.content.find((c: any) => c.type === 'text');
                if (textContent?.text) {
                    try {
                        const parsed = JSON.parse(textContent.text);
                        
                        // Handle search results
                        if (parsed.items && Array.isArray(parsed.items) && parsed.items.length > 0) {
                            // Get the first Dockerfile found
                            const dockerfile = parsed.items[0];
                            const path = dockerfile.path || dockerfile.name || 'Dockerfile';
                            this.logger.log(`🔍 search_code found Dockerfile at: ${path}`);
                            return `./${path}`;
                        }
                        
                        // Handle case where result is direct array
                        if (Array.isArray(parsed) && parsed.length > 0) {
                            const path = parsed[0].path || 'Dockerfile';
                            return `./${path}`;
                        }
                    } catch {
                        this.logger.debug('search_code response not JSON, checking raw text');
                    }
                }
            }
            
            // Fallback: Check root directory for Dockerfile
            return this.checkDockerfileInRoot(client, owner, repo, branch, token);
        } catch (error) {
            this.logger.warn(`search_code failed, using fallback: ${(error as Error).message}`);
            return this.checkDockerfileInRoot(client, owner, repo, branch, token);
        }
    }

    /**
     * Fallback: Check if Dockerfile exists in root directory
     */
    private async checkDockerfileInRoot(
        client: Client,
        owner: string,
        repo: string,
        branch: string,
        token?: string,
    ): Promise<string | null> {
        try {
            const content = await this.mcpGetFileContent(client, owner, repo, 'Dockerfile', branch, token);
            if (content && content.length > 0) {
                return './Dockerfile';
            }
            return null;
        } catch {
            return null;
        }
    }

    // ==================== DOCKERFILE GENERATION ====================

    /**
     * Generate Dockerfile and .dockerignore, then push to repository
     * Uses Gemini to generate intelligent Dockerfile based on analysis
     */
    async generateAndPushDockerfile(
        token: string,
        repository: string,
        branch: string,
        analysisResult: SmartAnalysisResult,
    ): Promise<DockerfileGenerationResponse> {
        const startTime = Date.now();
        const [owner, repo] = this.parseRepoName(repository);

        this.logger.log(`🐳 Generating Dockerfile for: ${owner}/${repo} @ ${branch}`);

        let client: Client | null = null;

        try {
            // Step 1: Generate Dockerfile content using Gemini
            const dockerfileContent = await this.geminiService.generateDockerfile(analysisResult);
            this.logger.log(`✅ Dockerfile generated (${dockerfileContent.length} chars)`);

            // Step 2: Generate .dockerignore content
            const dockerignoreContent = this.generateDockerignore(analysisResult.detected_language);
            this.logger.log(`✅ .dockerignore generated (${dockerignoreContent.length} chars)`);

            // Step 3: Create MCP client
            client = await this.createMcpClient(token);
            this.logger.log('✅ MCP client connected for push');

            // Step 4: Push Dockerfile to repository
            await this.pushFileToRepo(client, owner, repo, branch, 'Dockerfile', dockerfileContent, 'Add Dockerfile for containerization');
            this.logger.log('✅ Dockerfile pushed to repository');

            // Step 5: Push .dockerignore to repository
            await this.pushFileToRepo(client, owner, repo, branch, '.dockerignore', dockerignoreContent, 'Add .dockerignore');
            this.logger.log('✅ .dockerignore pushed to repository');

            const duration = Date.now() - startTime;

            return {
                success: true,
                repository,
                branch,
                duration: `${duration}ms`,
                files_created: ['Dockerfile', '.dockerignore'],
                dockerfile_content: dockerfileContent,
                dockerignore_content: dockerignoreContent,
            };
        } catch (error) {
            const duration = Date.now() - startTime;
            this.logger.error(`❌ Dockerfile generation failed: ${(error as Error).message}`);

            return {
                success: false,
                repository,
                branch,
                duration: `${duration}ms`,
                files_created: [],
                error: (error as Error).message,
            };
        } finally {
            if (client) {
                try {
                    await client.close();
                    this.logger.log('🧹 MCP client closed');
                } catch { }
            }
        }
    }

    /**
     * Push a single file to repository using MCP create_or_update_file
     */
    private async pushFileToRepo(
        client: Client,
        owner: string,
        repo: string,
        branch: string,
        path: string,
        content: string,
        message: string,
    ): Promise<void> {
        try {
            await client.callTool({
                name: 'create_or_update_file',
                arguments: {
                    owner,
                    repo,
                    path,
                    content,
                    message,
                    branch,
                },
            });
        } catch (error) {
            this.logger.error(`Failed to push ${path}: ${(error as Error).message}`);
            throw new Error(`Failed to push ${path} to repository: ${(error as Error).message}`);
        }
    }

    /**
     * Generate .dockerignore content based on detected language
     */
    private generateDockerignore(language: string): string {
        const commonIgnores = [
            '# Dependencies',
            'node_modules/',
            '__pycache__/',
            '*.pyc',
            '.venv/',
            'venv/',
            'target/',
            'vendor/',
            '',
            '# IDE',
            '.idea/',
            '.vscode/',
            '*.swp',
            '*.swo',
            '',
            '# Git',
            '.git/',
            '.gitignore',
            '',
            '# Docker',
            'Dockerfile',
            '.dockerignore',
            'docker-compose*.yml',
            '',
            '# Environment',
            '.env',
            '.env.local',
            '.env.*.local',
            '*.env',
            '',
            '# Logs',
            'logs/',
            '*.log',
            'npm-debug.log*',
            '',
            '# Testing',
            'coverage/',
            '.nyc_output/',
            '.pytest_cache/',
            '',
            '# Build artifacts',
            'dist/',
            'build/',
            '*.jar',
            '*.war',
            '',
            '# OS files',
            '.DS_Store',
            'Thumbs.db',
        ];

        // Language-specific additions
        const languageSpecific: Record<string, string[]> = {
            node: ['# Node specific', 'npm-debug.log', 'yarn-error.log', '.npm/', '.yarn/'],
            python: ['# Python specific', '*.egg-info/', '.eggs/', '*.egg', 'pip-log.txt'],
            java: ['# Java specific', '*.class', '.gradle/', '.mvn/', 'gradle/', '!gradle-wrapper.jar'],
            go: ['# Go specific', '*.exe', '*.test', '*.out'],
            rust: ['# Rust specific', 'Cargo.lock', '*.rlib'],
        };

        const specific = languageSpecific[language] || [];
        
        return [...commonIgnores, '', ...specific].join('\n');
    }
}
