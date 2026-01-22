import { useState } from 'react';

interface JsonDisplayProps {
    data: Record<string, unknown> | null | undefined;
}

/**
 * JsonDisplay component for rendering formatted JSON with collapsible sections.
 * Provides syntax highlighting and copy functionality.
 */
function JsonDisplay({ data }: JsonDisplayProps) {
    const [isExpanded, setIsExpanded] = useState(false);
    const [copied, setCopied] = useState(false);

    if (!data) {
        return (
            <div className="json-display empty">
                <p>No data available</p>
            </div>
        );
    }

    const jsonString = JSON.stringify(data, null, 2);
    const previewLines = 15;
    const lines = jsonString.split('\n');
    const shouldTruncate = lines.length > previewLines;
    const displayContent = isExpanded
        ? jsonString
        : lines.slice(0, previewLines).join('\n') + (shouldTruncate ? '\n...' : '');

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(jsonString);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy:', err);
        }
    };

    return (
        <div className="json-display">
            <div className="json-toolbar">
                <button className="json-button copy-button" onClick={handleCopy}>
                    {copied ? '✓ Copied!' : '📋 Copy'}
                </button>
                {shouldTruncate && (
                    <button
                        className="json-button expand-button"
                        onClick={() => setIsExpanded(!isExpanded)}
                    >
                        {isExpanded ? '🔼 Collapse' : `🔽 Expand (${lines.length} lines)`}
                    </button>
                )}
            </div>
            <pre className="json-content">
                <code>{displayContent}</code>
            </pre>
        </div>
    );
}

export default JsonDisplay;
