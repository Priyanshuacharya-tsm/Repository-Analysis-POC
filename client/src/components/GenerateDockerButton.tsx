import type { DockerfileGenerationResult } from '../App';

interface GenerateDockerButtonProps {
    onGenerate: () => void;
    isLoading: boolean;
    result: DockerfileGenerationResult | null;
}

/**
 * GenerateDockerButton component
 * Displays a button to trigger Dockerfile generation with status feedback
 */
function GenerateDockerButton({ onGenerate, isLoading, result }: GenerateDockerButtonProps) {
    // If generation was successful, show success state
    if (result?.status === 'success') {
        return (
            <div className="generate-docker-button success">
                <span className="button-icon">✅</span>
                <span className="button-text">Dockerfile Created!</span>
            </div>
        );
    }

    // If generation failed, show error with retry option
    if (result?.status === 'failed') {
        return (
            <div className="generate-docker-wrapper">
                <div className="generate-error">
                    <span className="error-icon">❌</span>
                    <span className="error-text">{result.error_message || 'Generation failed'}</span>
                </div>
                <button
                    className="generate-docker-button retry"
                    onClick={onGenerate}
                    disabled={isLoading}
                >
                    <span className="button-icon">🔄</span>
                    <span className="button-text">Retry Generation</span>
                </button>
            </div>
        );
    }

    // Default: Show generate button
    return (
        <button
            className="generate-docker-button"
            onClick={onGenerate}
            disabled={isLoading}
        >
            {isLoading ? (
                <>
                    <span className="button-spinner"></span>
                    <span className="button-text">Generating...</span>
                </>
            ) : (
                <>
                    <span className="button-icon">🐳</span>
                    <span className="button-text">Generate Dockerfile</span>
                </>
            )}
        </button>
    );
}

export default GenerateDockerButton;
