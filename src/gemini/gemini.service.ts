import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
import { SmartAnalysisResult, FetchedFiles } from '../mcp/dto/smart-analysis.dto';

/**
 * GeminiService - Generates structured JSON analysis using LLM
 * 
 * Features:
 * - Smart repository analysis with zero hardcoding
 * - Structured JSON extraction from file contents
 * - Context-aware prompts for accurate analysis
 * - Built-in rate limiter to prevent quota exhaustion (15 RPM limit)
 */
@Injectable()
export class GeminiService {
    private readonly logger = new Logger(GeminiService.name);
    private readonly genAI: GoogleGenerativeAI | null;
    private readonly model: GenerativeModel | null;
    private readonly isConfigured: boolean;

    // Rate limiter configuration (Gemini Free: 15 RPM)
    private readonly MIN_DELAY_MS = 4000; // 4 seconds between requests = max 15 RPM
    private lastRequestTime = 0;
    private requestQueue: Array<{
        resolve: (value: SmartAnalysisResult) => void;
        reject: (error: Error) => void;
        repository: string;
        branch: string;
        fileContents: FetchedFiles;
    }> = [];
    private isProcessingQueue = false;

    constructor(private readonly configService: ConfigService) {
        const apiKey = this.configService.get<string>('GEMINI_API_KEY');

        if (!apiKey || apiKey === 'your_gemini_api_key_here') {
            this.logger.warn('⚠️ GEMINI_API_KEY not configured');
            this.genAI = null;
            this.model = null;
            this.isConfigured = false;
        } else {
            this.genAI = new GoogleGenerativeAI(apiKey);
            this.model = this.genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
            this.isConfigured = true;
            this.logger.log('🤖 Gemini AI ready (rate limited: 15 RPM)');
        }
    }

    // ==================== RATE LIMITER ====================

    /**
     * Sleep utility for rate limiting
     */
    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Process the request queue one by one with rate limiting
     */
    private async processQueue(): Promise<void> {
        if (this.isProcessingQueue) return;
        this.isProcessingQueue = true;

        while (this.requestQueue.length > 0) {
            const request = this.requestQueue.shift()!;
            
            // Calculate wait time to respect rate limit
            const now = Date.now();
            const timeSinceLastRequest = now - this.lastRequestTime;
            const waitTime = Math.max(0, this.MIN_DELAY_MS - timeSinceLastRequest);

            if (waitTime > 0) {
                this.logger.log(`⏳ Rate limiter: waiting ${waitTime}ms before next request (queue: ${this.requestQueue.length} pending)`);
                await this.sleep(waitTime);
            }

            try {
                const result = await this.executeAnalysis(
                    request.repository,
                    request.branch,
                    request.fileContents,
                );
                this.lastRequestTime = Date.now();
                request.resolve(result);
            } catch (error) {
                request.reject(error as Error);
            }
        }

        this.isProcessingQueue = false;
    }

    // ==================== SMART ANALYSIS ====================

    /**
     * Analyze repository files using LLM - zero hardcoding
     * Returns structured JSON matching SmartAnalysisResult
     * 
     * This method queues requests to respect API rate limits (15 RPM)
     */
    async analyzeFiles(
        repository: string,
        branch: string,
        fileContents: FetchedFiles,
    ): Promise<SmartAnalysisResult> {
        if (!this.isConfigured || !this.model) {
            this.logger.warn('Gemini not configured, using fallback analysis');
            return this.generateFallbackAnalysis(fileContents);
        }

        // Add request to queue and return a promise
        return new Promise((resolve, reject) => {
            this.requestQueue.push({
                resolve,
                reject,
                repository,
                branch,
                fileContents,
            });

            this.logger.log(`📋 Request queued for ${repository}@${branch} (queue size: ${this.requestQueue.length})`);
            
            // Start processing queue (non-blocking)
            this.processQueue();
        });
    }

    /**
     * Execute the actual Gemini API call (called by queue processor)
     */
    private async executeAnalysis(
        repository: string,
        branch: string,
        fileContents: FetchedFiles,
    ): Promise<SmartAnalysisResult> {
        try {
            // DEBUG: Log what files are being sent to Gemini
            this.logger.debug(`📋 Files to analyze: ${Object.keys(fileContents).join(', ')}`);
            for (const [name, content] of Object.entries(fileContents)) {
                this.logger.debug(`   📄 ${name}: ${content.length} chars - Preview: ${content.substring(0, 100).replace(/\n/g, '\\n')}...`);
            }

            const prompt = this.buildSmartAnalysisPrompt(repository, branch, fileContents);
            this.logger.log(`🧠 Sending ${Object.keys(fileContents).length} files to Gemini for analysis`);

            const result = await this.model!.generateContent(prompt);
            const responseText = result.response.text();

            return this.parseAndValidateAnalysis(responseText);
        } catch (error) {
            this.logger.error(`Gemini analysis error: ${(error as Error).message}`);
            return this.generateFallbackAnalysis(fileContents);
        }
    }

    /**
     * Build structured prompt for smart analysis
     * DYNAMIC: Handles Node, Python, Java, Go, Rust, Ruby, PHP, .NET with smart inference logic.
     */
    private buildSmartAnalysisPrompt(
        repository: string,
        branch: string,
        files: FetchedFiles,
    ): string {
        const fileContentsSection = Object.entries(files)
            .map(([name, content]) => {
                // Truncate very large files to save tokens, but keep enough for context
                const truncatedContent = content.length > 8000
                    ? content.substring(0, 8000) + '\n... [truncated]'
                    : content;
                return `### ${name}\n\`\`\`\n${truncatedContent}\n\`\`\``;
            })
            .join('\n\n');

        return `You are a Senior DevOps Architect. Analyze code files and extract deployment metadata dynamically.

## CONTEXT
- Repository: ${repository}
- Branch: ${branch}

## FILES PROVIDED:
${fileContentsSection}

## TASK
Analyze the provided configuration files to determine the tech stack, version, and deployment commands. 
Intelligently infer missing data based on standard conventions.

## REQUIRED OUTPUT SCHEMA (JSON ONLY):
{
  "detected_language": "node" | "python" | "java" | "go" | "php" | "rust" | "ruby" | "dotnet" | "unknown",
  "detected_version": "<version_string>" or null,
  "is_docker_present": boolean,
  "dockerfile_location": "<path>" or null,
  "detected_frameworks": ["<framework1>", "<framework2>"],
  "detected_dependencies": ["<dep1>", "<dep2>"],
  "detected_start_cmd": "<full command>" or null,
  "detected_build_cmd": "<full command>" or null,
  "env_vars_needed": ["<VAR1>", "<VAR2>"]
}

## ANALYSIS RULES:

### 1. Language Detection
- package.json → "node"
- requirements.txt / pyproject.toml / Pipfile → "python"
- pom.xml / build.gradle → "java"
- go.mod → "go"
- composer.json → "php"
- Cargo.toml → "rust"
- Gemfile → "ruby"
- *.csproj / *.sln → "dotnet"

### 2. Version Detection (Smart Inference - PRIORITY ORDER)

**Node.js:**
1. \`engines.node\` in package.json (e.g., ">=18" → "18")
2. \`.nvmrc\` or \`.node-version\` file content
3. **IMPORTANT:** Check \`devDependencies["@types/node"]\`:
   - "^22.x" or "^22.10.7" → infer "22"
   - "^20.x" → infer "20"
   - "^18.x" → infer "18"
4. NestJS 10+ or modern ESM → minimum "18"
5. Default: "20" (current LTS)

**Python:**
1. runtime.txt content
2. pyproject.toml \`requires-python\`
3. Pipfile \`python_version\`
4. Default: "3.11"

**Java:**
1. pom.xml \`<java.version>\` or \`<maven.compiler.source>\`
2. build.gradle \`sourceCompatibility\`
3. Default: "21"

**Go:** go.mod \`go X.XX\` line, default "1.21"

### 3. Framework Detection
Extract from dependencies:
- **Node:** NestJS, Express, Fastify, Next.js, React, Vue, Angular
- **Python:** FastAPI, Django, Flask, Starlette, Celery
- **Java:** Spring Boot, Quarkus, Micronaut
- **Go:** Gin, Echo, Fiber, Chi

### 4. Dependency Extraction (Infrastructure Only)
**INCLUDE:** Cloud SDKs (@google/generative-ai, aws-sdk, @azure/*), AI (langchain, openai), 
Databases (pg, mysql2, mongodb, mongoose, redis, typeorm), Auth (passport), Validation (zod, class-validator)
**EXCLUDE:** Dev tools, utilities, internal framework packages

### 5. Command Extraction (PRODUCTION) - IMPORTANT!
**ONLY return commands for scripts that ACTUALLY EXIST in the files. Return null if not found.**

**Node.js:** Check \`scripts\` object in package.json. Use this priority:
- **Start Command:** 
  1. If \`start:prod\` exists → "npm run start:prod"
  2. Else if \`prod\` exists → "npm run prod"  
  3. Else if \`start\` exists → "npm start"
  4. Else → null (DO NOT GUESS)
- **Build Command:**
  1. If \`build\` or \`build:prod\` exists → "npm run build"
  2. Else → null (DO NOT GUESS - many Node apps don't need build)

**Python:** Check Procfile. If not found, infer from framework (uvicorn for FastAPI, gunicorn for Django/Flask)
**Java:** Build: "mvn clean package" or "./gradlew build" | Start: "java -jar target/app.jar"

### 6. Environment Variables
Extract variable NAMES from .env.example, .env.sample, .env.template (ignore comments)

## CRITICAL RULES:
1. ONLY extract data that EXISTS in the provided files
2. DO NOT assume or guess commands that don't exist in scripts
3. Return null for any field where data cannot be found
4. For detected_version, use inference rules but always return a value for Node.js

## OUTPUT
Return ONLY the JSON object. No markdown. Clean version strings (e.g., "22" not ">=22.0.0").`;
    }

    /**
     * Parse and validate the LLM response
     * Ensures all required fields exist with correct types
     */
    private parseAndValidateAnalysis(responseText: string): SmartAnalysisResult {
        try {
            // Clean up response - remove markdown code blocks if present
            let cleanedResponse = responseText.trim();
            
            // Remove various markdown code block formats
            if (cleanedResponse.startsWith('```json')) {
                cleanedResponse = cleanedResponse.slice(7);
            } else if (cleanedResponse.startsWith('```')) {
                cleanedResponse = cleanedResponse.slice(3);
            }
            if (cleanedResponse.endsWith('```')) {
                cleanedResponse = cleanedResponse.slice(0, -3);
            }
            cleanedResponse = cleanedResponse.trim();

            const parsed = JSON.parse(cleanedResponse);

            // Validate and ensure all required fields exist with correct types
            return {
                detected_language: this.validateString(parsed.detected_language, 'unknown'),
                detected_version: this.validateNullableString(parsed.detected_version),
                is_docker_present: Boolean(parsed.is_docker_present),
                dockerfile_location: this.validateNullableString(parsed.dockerfile_location),
                detected_frameworks: this.validateStringArray(parsed.detected_frameworks),
                detected_dependencies: this.validateStringArray(parsed.detected_dependencies),
                detected_start_cmd: this.validateNullableString(parsed.detected_start_cmd),
                detected_build_cmd: this.validateNullableString(parsed.detected_build_cmd),
                env_vars_needed: this.validateStringArray(parsed.env_vars_needed),
            };
        } catch (error) {
            this.logger.error(`Failed to parse LLM response: ${(error as Error).message}`);
            this.logger.debug(`Raw response: ${responseText.substring(0, 500)}`);
            return this.getEmptyAnalysis();
        }
    }

    /**
     * Validate string field with default value
     */
    private validateString(value: any, defaultValue: string): string {
        return typeof value === 'string' && value.trim() ? value.trim() : defaultValue;
    }

    /**
     * Validate nullable string field
     */
    private validateNullableString(value: any): string | null {
        return typeof value === 'string' && value.trim() ? value.trim() : null;
    }

    /**
     * Validate string array field
     */
    private validateStringArray(value: any): string[] {
        if (!Array.isArray(value)) return [];
        return value
            .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
            .map(item => item.trim());
    }

    /**
     * Fallback analysis when Gemini is unavailable
     * Basic file-based detection without LLM
     */
    private generateFallbackAnalysis(files: FetchedFiles): SmartAnalysisResult {
        const result = this.getEmptyAnalysis();

        // Basic language and framework detection from files
        if (files['package.json']) {
            result.detected_language = 'node';
            try {
                const pkg = JSON.parse(files['package.json']);
                
                // Extract version
                if (pkg.engines?.node) {
                    const match = pkg.engines.node.match(/(\d+)/);
                    result.detected_version = match ? `${match[1]}.x` : null;
                }
                
                // Extract commands
                result.detected_start_cmd = pkg.scripts?.start ? 'npm start' 
                    : pkg.scripts?.['start:prod'] ? 'npm run start:prod' : null;
                result.detected_build_cmd = pkg.scripts?.build ? 'npm run build' : null;
                
                // Extract frameworks from dependencies
                const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
                const frameworkMap: Record<string, string> = {
                    '@nestjs/core': 'NestJS',
                    'express': 'Express.js',
                    'fastify': 'Fastify',
                    'koa': 'Koa',
                    'next': 'Next.js',
                    'react': 'React',
                    'vue': 'Vue.js',
                    '@angular/core': 'Angular',
                    'svelte': 'Svelte',
                };
                const externalDeps: Record<string, string> = {
                    'pg': 'pg',
                    'mysql2': 'mysql2',
                    'mongodb': 'mongodb',
                    'mongoose': 'mongoose',
                    'redis': 'redis',
                    'ioredis': 'ioredis',
                    'aws-sdk': 'aws-sdk',
                    '@aws-sdk/client-s3': 'aws-sdk',
                };
                
                for (const [dep, name] of Object.entries(frameworkMap)) {
                    if (allDeps[dep]) result.detected_frameworks.push(name);
                }
                for (const [dep, name] of Object.entries(externalDeps)) {
                    if (allDeps[dep] && !result.detected_dependencies.includes(name)) {
                        result.detected_dependencies.push(name);
                    }
                }
            } catch { /* ignore parse errors */ }
        } else if (files['requirements.txt'] || files['pyproject.toml']) {
            result.detected_language = 'python';
            // Basic Python framework detection
            const content = files['requirements.txt'] || files['pyproject.toml'] || '';
            if (content.includes('fastapi')) result.detected_frameworks.push('FastAPI');
            if (content.includes('django')) result.detected_frameworks.push('Django');
            if (content.includes('flask')) result.detected_frameworks.push('Flask');
        } else if (files['pom.xml'] || files['build.gradle']) {
            result.detected_language = 'java';
            const content = files['pom.xml'] || files['build.gradle'] || '';
            if (content.includes('spring-boot')) result.detected_frameworks.push('Spring Boot');
        } else if (files['go.mod']) {
            result.detected_language = 'go';
        } else if (files['Cargo.toml']) {
            result.detected_language = 'rust';
        }

        // Docker detection
        if (files['Dockerfile']) {
            result.is_docker_present = true;
            result.dockerfile_location = './Dockerfile';
        }

        // Env vars from .env.example
        const envFile = files['.env.example'] || files['.env.sample'] || files['.env.template'];
        if (envFile) {
            result.env_vars_needed = envFile
                .split('\n')
                .filter(line => line.includes('=') && !line.trim().startsWith('#'))
                .map(line => line.split('=')[0].trim())
                .filter(Boolean);
        }

        return result;
    }

    /**
     * Return empty analysis structure
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

    // ==================== DOCKERFILE GENERATION ====================

    /**
     * Generate Dockerfile content using LLM based on analysis result
     * Creates production-ready, optimized Dockerfile
     */
    async generateDockerfile(analysisResult: SmartAnalysisResult): Promise<string> {
        if (!this.isConfigured || !this.model) {
            this.logger.warn('Gemini not configured, using template-based Dockerfile');
            return this.generateTemplateDockerfile(analysisResult);
        }

        try {
            const prompt = this.buildDockerfilePrompt(analysisResult);
            this.logger.log(`🐳 Generating Dockerfile for ${analysisResult.detected_language} project`);

            // Rate limit: wait if needed
            const now = Date.now();
            const timeSinceLastRequest = now - this.lastRequestTime;
            const waitTime = Math.max(0, this.MIN_DELAY_MS - timeSinceLastRequest);
            
            if (waitTime > 0) {
                this.logger.log(`⏳ Rate limiter: waiting ${waitTime}ms`);
                await this.sleep(waitTime);
            }

            const result = await this.model.generateContent(prompt);
            this.lastRequestTime = Date.now();
            
            const responseText = result.response.text();
            
            // Clean up response - remove markdown code blocks
            let dockerfile = responseText.trim();
            if (dockerfile.startsWith('```dockerfile')) {
                dockerfile = dockerfile.slice(13);
            } else if (dockerfile.startsWith('```Dockerfile')) {
                dockerfile = dockerfile.slice(13);
            } else if (dockerfile.startsWith('```')) {
                dockerfile = dockerfile.slice(3);
            }
            if (dockerfile.endsWith('```')) {
                dockerfile = dockerfile.slice(0, -3);
            }

            return dockerfile.trim();
        } catch (error) {
            this.logger.error(`Dockerfile generation error: ${(error as Error).message}`);
            return this.generateTemplateDockerfile(analysisResult);
        }
    }

    /**
     * Build prompt for Dockerfile generation
     */
    private buildDockerfilePrompt(analysis: SmartAnalysisResult): string {
        return `You are a senior DevOps engineer. Generate a production-ready Dockerfile based on the following project analysis.

## PROJECT ANALYSIS
- Language: ${analysis.detected_language}
- Version: ${analysis.detected_version || 'latest'}
- Frameworks: ${analysis.detected_frameworks.join(', ') || 'None detected'}
- External Dependencies: ${analysis.detected_dependencies.join(', ') || 'None'}
- Build Command: ${analysis.detected_build_cmd || 'Not specified'}
- Start Command: ${analysis.detected_start_cmd || 'Not specified'}
- Environment Variables: ${analysis.env_vars_needed.join(', ') || 'None'}

## REQUIREMENTS
1. Use multi-stage build for optimization (if applicable)
2. Use Alpine images where possible for smaller size
3. Set appropriate WORKDIR
4. Copy dependency files first (for Docker layer caching)
5. Install dependencies
6. Copy source code
7. Build application (if build command exists)
8. Expose appropriate port (3000 for Node, 8000 for Python, 8080 for Java, etc.)
9. Set proper CMD or ENTRYPOINT
10. Add health check if applicable
11. Run as non-root user for security

## OUTPUT
Return ONLY the Dockerfile content. No explanations, no markdown formatting.
Start directly with FROM instruction.`;
    }

    /**
     * Fallback: Generate Dockerfile from template when Gemini unavailable
     */
    private generateTemplateDockerfile(analysis: SmartAnalysisResult): string {
        const { detected_language, detected_version, detected_build_cmd, detected_start_cmd, env_vars_needed } = analysis;
        
        const version = detected_version || 'latest';

        switch (detected_language) {
            case 'node':
                return this.generateNodeDockerfile(version, detected_build_cmd, detected_start_cmd, env_vars_needed);
            case 'python':
                return this.generatePythonDockerfile(version, detected_start_cmd, env_vars_needed);
            case 'java':
                return this.generateJavaDockerfile(version, detected_build_cmd, env_vars_needed);
            case 'go':
                return this.generateGoDockerfile(version, env_vars_needed);
            default:
                return this.generateGenericDockerfile(env_vars_needed);
        }
    }

    private generateNodeDockerfile(version: string, buildCmd: string | null, startCmd: string | null, envVars: string[]): string {
        // Ensure we have a valid Node version - default to 20 LTS
        const nodeVersion = version ? version.replace('.x', '').replace('>=', '').split('.')[0] : '20';
        const envSection = envVars.length > 0 ? envVars.map(v => `ENV ${v}=`).join('\n') + '\n\n' : '';
        
        // Determine if using TypeScript (NestJS typically uses TS)
        const hasTypescript = buildCmd && buildCmd.includes('build');
        const distFolder = hasTypescript ? 'dist' : '.';
        const entryPoint = hasTypescript ? 'dist/main.js' : 'index.js';
        
        return `# Build stage
FROM node:${nodeVersion}-alpine AS builder

WORKDIR /app

# Copy package files for better caching
COPY package*.json ./

# Install ALL dependencies (including dev for build)
RUN npm ci

# Copy source code
COPY . .

# Build application
${buildCmd ? `RUN ${buildCmd}` : '# No build step required'}

# Production stage
FROM node:${nodeVersion}-alpine AS production

WORKDIR /app

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

# Copy package files
COPY --from=builder /app/package*.json ./

# Install production dependencies only
RUN npm ci --only=production && npm cache clean --force

# Copy built application
${hasTypescript ? `COPY --from=builder --chown=nodejs:nodejs /app/${distFolder} ./${distFolder}` : 'COPY --from=builder --chown=nodejs:nodejs /app .'}

${envSection}# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \\
    CMD node -e "require('http').get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))" || exit 1

# Start application
CMD ${startCmd ? `["sh", "-c", "${startCmd}"]` : `["node", "${entryPoint}"]`}
`;
    }

    private generatePythonDockerfile(version: string, startCmd: string | null, envVars: string[]): string {
        const pythonVersion = version || '3.11';
        const envSection = envVars.length > 0 ? envVars.map(v => `ENV ${v}=`).join('\n') + '\n\n' : '';

        return `FROM python:${pythonVersion}-slim

WORKDIR /app

# Create non-root user
RUN groupadd -r appuser && useradd -r -g appuser appuser

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \\
    curl \\
    && rm -rf /var/lib/apt/lists/*

# Copy requirements
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy source
COPY --chown=appuser:appuser . .

${envSection}# Switch to non-root user
USER appuser

# Expose port
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \\
    CMD curl -f http://localhost:8000/health || exit 1

# Start application
CMD ${startCmd ? `["${startCmd.split(' ').join('", "')}"]` : '["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]'}
`;
    }

    private generateJavaDockerfile(version: string, buildCmd: string | null, envVars: string[]): string {
        const javaVersion = version || '21';
        const envSection = envVars.length > 0 ? envVars.map(v => `ENV ${v}=`).join('\n') + '\n\n' : '';

        return `# Build stage
FROM eclipse-temurin:${javaVersion}-jdk-alpine AS builder

WORKDIR /app

# Copy Maven/Gradle files
COPY pom.xml mvnw* ./
COPY .mvn .mvn

# Download dependencies
RUN ./mvnw dependency:go-offline -B || true

# Copy source
COPY src ./src

# Build
RUN ./mvnw clean package -DskipTests -B

# Production stage
FROM eclipse-temurin:${javaVersion}-jre-alpine

WORKDIR /app

# Create non-root user
RUN addgroup -g 1001 -S appgroup && adduser -S appuser -u 1001 -G appgroup

# Copy JAR from builder
COPY --from=builder --chown=appuser:appgroup /app/target/*.jar app.jar

${envSection}# Switch to non-root user
USER appuser

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \\
    CMD wget --no-verbose --tries=1 --spider http://localhost:8080/actuator/health || exit 1

# Start application
CMD ["java", "-jar", "app.jar"]
`;
    }

    private generateGoDockerfile(version: string, envVars: string[]): string {
        const goVersion = version || '1.21';
        const envSection = envVars.length > 0 ? envVars.map(v => `ENV ${v}=`).join('\n') + '\n\n' : '';

        return `# Build stage
FROM golang:${goVersion}-alpine AS builder

WORKDIR /app

# Copy go mod files
COPY go.mod go.sum ./

# Download dependencies
RUN go mod download

# Copy source
COPY . .

# Build
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o main .

# Production stage
FROM alpine:latest

RUN apk --no-cache add ca-certificates

WORKDIR /app

# Create non-root user
RUN addgroup -g 1001 -S appgroup && adduser -S appuser -u 1001 -G appgroup

# Copy binary from builder
COPY --from=builder --chown=appuser:appgroup /app/main .

${envSection}# Switch to non-root user
USER appuser

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \\
    CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# Start application
CMD ["./main"]
`;
    }

    private generateGenericDockerfile(envVars: string[]): string {
        const envSection = envVars.length > 0 ? envVars.map(v => `ENV ${v}=`).join('\n') + '\n\n' : '';

        return `FROM alpine:latest

WORKDIR /app

# Install common tools
RUN apk add --no-cache bash curl

# Copy source
COPY . .

${envSection}# Expose port
EXPOSE 8080

# Start command - customize based on your application
CMD ["./start.sh"]
`;
    }
}
