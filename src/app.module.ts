import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { McpModule } from './mcp/mcp.module';
import { GeminiModule } from './gemini/gemini.module';

/**
 * AppModule is the root module of the application.
 * 
 * Module Structure:
 * - ConfigModule: Global environment variable management
 * - AuthModule: GitHub OAuth authentication
 * - McpModule: MCP spawner for repository analysis
 * - GeminiModule: AI documentation generation
 */
@Module({
  imports: [
    // Global configuration - loads .env variables
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),

    // Feature modules
    AuthModule,
    McpModule,
    GeminiModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule { }
