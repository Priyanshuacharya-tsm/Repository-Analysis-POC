interface LoaderProps {
    message?: string;
}

/**
 * Loader component with animated spinner and status message.
 * Displays during MCP server spawning and analysis.
 */
function Loader({ message = 'Loading...' }: LoaderProps) {
    return (
        <div className="loader-container">
            <div className="loader-spinner">
                <div className="spinner-ring"></div>
                <div className="spinner-ring"></div>
                <div className="spinner-ring"></div>
                <div className="spinner-core"></div>
            </div>
            <p className="loader-message">{message}</p>
            <div className="loader-dots">
                <span className="dot"></span>
                <span className="dot"></span>
                <span className="dot"></span>
            </div>
        </div>
    );
}

export default Loader;
