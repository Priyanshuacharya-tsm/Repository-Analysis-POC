import { Module, Global } from '@nestjs/common';
import { GeminiService } from './gemini.service';

/**
 * GeminiModule provides AI documentation generation capabilities.
 * Marked as @Global so it can be used across all modules without explicit imports.
 */
@Global()
@Module({
    providers: [GeminiService],
    exports: [GeminiService],
})
export class GeminiModule { }
