/**
 * Abstracted Repository Analysis Summary DTO
 * This is the clean, minimal JSON structure exposed to the frontend
 */

export interface RepoAnalysisSummary {
    repository_name: string;
    has_dockerfile: boolean;
    has_dockerignore: boolean;
    has_readme: boolean;
    detected_ports: string[];
    suggested_runtime: string | null;
    detected_framework: string | null;
}

export interface ActionableItem {
    item: 'dockerfile' | 'dockerignore' | 'readme';
    is_present: boolean;
    action_required: boolean;
    frontend_component: string;
}

export interface RepoAnalysisResponse {
    success: boolean;
    repo_analysis_summary: RepoAnalysisSummary;
    actionable_items: ActionableItem[];
    duration: string;
}

export interface DockerfileGenerationRequest {
    repository: string;
    token: string;
    branch?: string;
}

export interface DockerfileGenerationResponse {
    operation: 'dockerfile_generation';
    status: 'success' | 'failed';
    generated_file_path: string;
    confirmation_tick: boolean;
    dockerfile_content?: string;
    error_message?: string;
}

export interface DeepCodeAnalysis {
    language: string;
    languageVersion: string | null;
    packageManager: string | null;
    dependencyFile: string | null;
    entryPoint: string | null;
    buildCommand: string | null;
    startCommand: string | null;
    staticAssetDir: string | null;
    framework: string | null;
    baseImage: string;
    workdir: string;
    exposedPorts: string[];
}
