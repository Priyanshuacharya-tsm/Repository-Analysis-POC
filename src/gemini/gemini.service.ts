import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';

/**
 * GeminiService - Generates structured JSON analysis summary
 */
@Injectable()
export class GeminiService {
    private readonly logger = new Logger(GeminiService.name);
    private readonly genAI: GoogleGenerativeAI | null;
    private readonly model: GenerativeModel | null;
    private readonly isConfigured: boolean;

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
            this.logger.log('🤖 Gemini AI ready');
        }
    }

    /**
     * Generate concise analysis summary
     */
    async generateDocumentation(repoData: any): Promise<string> {
        if (!this.isConfigured || !this.model) {
            return this.generateFallbackSummary(repoData);
        }

        try {
            const prompt = this.buildPrompt(repoData);
            const result = await this.model.generateContent(prompt);
            return result.response.text();
        } catch (error) {
            this.logger.error(`Gemini error: ${(error as Error).message}`);
            return this.generateFallbackSummary(repoData);
        }
    }

    /**
     * Prompt for concise JSON-focused summary
     */
    private buildPrompt(repoData: any): string {
        return `Analyze this repository data and provide a CONCISE deployment summary.

## Repository Data
\`\`\`json
${JSON.stringify(repoData.detected, null, 2)}
\`\`\`

## Missing Items
${JSON.stringify(repoData.missing)}

## Instructions
Generate a BRIEF summary (max 300 words) with:

1. **Quick Overview** (1-2 sentences)
2. **Deployment Ready?** (Yes/No with reason)
3. **Recommended Platform** (one main recommendation)
4. **Action Items** (bullet list of what's needed)

Be direct and actionable. No long explanations.`;
    }

    /**
     * Fallback when Gemini unavailable
     */
    private generateFallbackSummary(repoData: any): string {
        const { detected, missing } = repoData;

        let summary = `## Quick Analysis\n\n`;

        // Language & Frameworks
        summary += `**Stack**: ${detected.language || 'Unknown'}`;
        if (detected.frameworks?.length) {
            summary += ` (${detected.frameworks.join(', ')})`;
        }
        summary += `\n\n`;

        // Deployment readiness
        const hasDocker = detected.docker?.exists;
        const hasBuild = detected.buildConfig?.scripts?.build;
        const hasStart = detected.buildConfig?.scripts?.start || detected.buildConfig?.scripts?.['start:prod'];

        if (hasDocker && hasBuild && hasStart) {
            summary += `**Deployment Ready**: ✅ Yes\n\n`;
        } else {
            summary += `**Deployment Ready**: ⚠️ Needs setup\n\n`;
        }

        // Ports
        if (detected.ports?.length) {
            summary += `**Ports**: ${detected.ports.join(', ')}\n\n`;
        }

        // Databases
        if (detected.databases?.length) {
            summary += `**Databases**: ${detected.databases.join(', ')}\n\n`;
        }

        // Missing items
        if (missing?.length) {
            summary += `**Missing**:\n`;
            missing.forEach((item: string) => {
                summary += `- ❌ ${item}\n`;
            });
            summary += `\n`;
        }

        // Recommendation
        summary += `**Recommended Platform**: `;
        if (detected.frameworks?.includes('Next.js') || detected.frameworks?.includes('Nuxt.js')) {
            summary += `Vercel`;
        } else if (hasDocker) {
            summary += `Railway, Fly.io, or AWS ECS`;
        } else if (detected.language === 'Python') {
            summary += `Railway or Render`;
        } else {
            summary += `Railway or Render (add Dockerfile first)`;
        }

        return summary;
    }
}
