import type { RepoAnalysisSummary } from '../App';

interface AnalysisSummaryProps {
    summary: RepoAnalysisSummary;
}

/**
 * AnalysisSummary component
 * Displays the abstracted repository analysis in a clean, visual format
 */
function AnalysisSummary({ summary }: AnalysisSummaryProps) {
    return (
        <div className="analysis-summary">
            {/* Quick Stats Grid */}
            <div className="summary-stats-grid">
                {/* Framework Detection */}
                <div className="summary-stat-card">
                    <span className="stat-icon">🚀</span>
                    <div className="stat-content">
                        <span className="stat-label">Framework</span>
                        <span className="stat-value">
                            {summary.detected_framework || 'Not detected'}
                        </span>
                    </div>
                </div>

                {/* Runtime Suggestion */}
                <div className="summary-stat-card">
                    <span className="stat-icon">⚙️</span>
                    <div className="stat-content">
                        <span className="stat-label">Suggested Runtime</span>
                        <span className="stat-value runtime">
                            {summary.suggested_runtime || 'Unknown'}
                        </span>
                    </div>
                </div>

                {/* Detected Ports */}
                <div className="summary-stat-card">
                    <span className="stat-icon">🔌</span>
                    <div className="stat-content">
                        <span className="stat-label">Exposed Ports</span>
                        <span className="stat-value ports">
                            {summary.detected_ports.length > 0
                                ? summary.detected_ports.join(', ')
                                : 'None detected'}
                        </span>
                    </div>
                </div>
            </div>

            {/* Critical Files Status */}
            <div className="critical-files-section">
                <h4 className="section-label">Critical Files Status</h4>
                <div className="critical-files-grid">
                    <div className={`file-status ${summary.has_dockerfile ? 'present' : 'missing'}`}>
                        <span className="file-icon">🐳</span>
                        <span className="file-name">Dockerfile</span>
                        <span className="file-status-badge">
                            {summary.has_dockerfile ? '✅ Present' : '❌ Missing'}
                        </span>
                    </div>

                    <div className={`file-status ${summary.has_dockerignore ? 'present' : 'missing'}`}>
                        <span className="file-icon">📄</span>
                        <span className="file-name">.dockerignore</span>
                        <span className="file-status-badge">
                            {summary.has_dockerignore ? '✅ Present' : '⚠️ Missing'}
                        </span>
                    </div>

                    <div className={`file-status ${summary.has_readme ? 'present' : 'missing'}`}>
                        <span className="file-icon">📝</span>
                        <span className="file-name">README.md</span>
                        <span className="file-status-badge">
                            {summary.has_readme ? '✅ Present' : '⚠️ Missing'}
                        </span>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default AnalysisSummary;
