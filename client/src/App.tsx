import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import Loader from './components/Loader';
import JsonDisplay from './components/JsonDisplay';
import AnalysisSummary from './components/AnalysisSummary';
import GenerateDockerButton from './components/GenerateDockerButton';
import './App.css';

// API Configuration
const API_BASE_URL = 'http://localhost:3000';

// Types
interface Repository {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  private: boolean;
  html_url: string;
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  updated_at: string;
  owner: {
    login: string;
    avatar_url: string;
  };
}

// Legacy analysis result type (for backward compatibility)
interface AnalysisResult {
  success: boolean;
  repository: string;
  duration: string;
  analysis: {
    detected: {
      language: string | null;
      frameworks: string[];
      databases: string[];
      ports: string[];
      envVars: string[];
      runtime: Record<string, string>;
      buildConfig: {
        name?: string;
        version?: string;
        description?: string;
        scripts?: Record<string, string>;
        engines?: Record<string, string>;
      };
      docker: {
        exists: boolean;
        baseImage?: string | null;
        exposedPorts?: string[];
        workdir?: string | null;
        cmd?: string | null;
        composeServices?: string[];
      } | null;
      cicd: {
        platform: string;
        configured: boolean;
      } | null;
    };
    missing: string[];
    filesAnalyzed: string[];
  };
  documentation: string;
  raw: Record<string, unknown>;
}

// NEW: Enhanced analysis types (abstracted for frontend)
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

export interface EnhancedAnalysisResult {
  success: boolean;
  repo_analysis_summary: RepoAnalysisSummary;
  actionable_items: ActionableItem[];
  duration: string;
}

export interface DockerfileGenerationResult {
  operation: 'dockerfile_generation';
  status: 'success' | 'failed';
  generated_file_path: string;
  confirmation_tick: boolean;
  dockerfile_content?: string;
  error_message?: string;
}

interface UserInfo {
  username: string;
  avatar: string;
}

type ViewState = 'connect' | 'dashboard';
type LoadingState = 'idle' | 'spawning' | 'analyzing' | 'generating' | 'fetching-repos' | 'generating-dockerfile';
type AnalysisMode = 'enhanced' | 'legacy';

function App() {
  // Authentication state
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<UserInfo | null>(null);
  const [view, setView] = useState<ViewState>('connect');
  const [error, setError] = useState<string | null>(null);

  // Repository state
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<Repository | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Analysis state
  const [loadingState, setLoadingState] = useState<LoadingState>('idle');
  const [result, setResult] = useState<AnalysisResult | null>(null);

  // NEW: Enhanced analysis state
  const [enhancedResult, setEnhancedResult] = useState<EnhancedAnalysisResult | null>(null);
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>('enhanced');
  const [dockerGenResult, setDockerGenResult] = useState<DockerfileGenerationResult | null>(null);

  // Parse URL params on mount (OAuth callback)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get('token');
    const urlUsername = params.get('username');
    const urlAvatar = params.get('avatar');
    const urlError = params.get('error');

    if (urlError) {
      setError(decodeURIComponent(urlError));
      window.history.replaceState({}, '', window.location.pathname);
      return;
    }

    if (urlToken && urlUsername) {
      setToken(urlToken);
      setUser({
        username: decodeURIComponent(urlUsername),
        avatar: urlAvatar ? decodeURIComponent(urlAvatar) : '',
      });
      setView('dashboard');
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  // Fetch repositories when user logs in
  useEffect(() => {
    if (token && view === 'dashboard' && repositories.length === 0) {
      fetchRepositories();
    }
  }, [token, view]);

  // Fetch user repositories
  const fetchRepositories = useCallback(async () => {
    if (!token) return;

    setLoadingState('fetching-repos');
    setError(null);

    try {
      const response = await axios.post<{ success: boolean; repositories: Repository[] }>(
        `${API_BASE_URL}/auth/repositories`,
        { token },
        { headers: { 'Content-Type': 'application/json' } }
      );

      if (response.data.success) {
        setRepositories(response.data.repositories);
      } else {
        setError('Failed to fetch repositories');
      }
    } catch (err) {
      setError('Failed to fetch repositories. Please try logging in again.');
    } finally {
      setLoadingState('idle');
    }
  }, [token]);

  // Handle GitHub login
  const handleLogin = useCallback(() => {
    window.location.href = `${API_BASE_URL}/auth/login`;
  }, []);

  // Handle logout
  const handleLogout = useCallback(() => {
    setToken(null);
    setUser(null);
    setView('connect');
    setResult(null);
    setEnhancedResult(null);
    setDockerGenResult(null);
    setError(null);
    setRepositories([]);
    setSelectedRepo(null);
    setSearchQuery('');
  }, []);

  // Handle repository selection
  const handleSelectRepo = useCallback((repo: Repository) => {
    setSelectedRepo(repo);
    setResult(null);
    setEnhancedResult(null);
    setDockerGenResult(null);
    setError(null);
  }, []);

  // Handle repository analysis (enhanced mode)
  const handleAnalyze = useCallback(async () => {
    if (!selectedRepo || !token) return;

    setError(null);
    setResult(null);
    setEnhancedResult(null);
    setDockerGenResult(null);

    try {
      setLoadingState('spawning');
      await new Promise(resolve => setTimeout(resolve, 500));

      setLoadingState('analyzing');

      if (analysisMode === 'enhanced') {
        // NEW: Use enhanced analysis endpoint
        const response = await axios.post<EnhancedAnalysisResult>(
          `${API_BASE_URL}/api/mcp/analyze/enhanced`,
          {
            repository: selectedRepo.full_name,
            token: token,
          },
          {
            headers: { 'Content-Type': 'application/json' },
          }
        );

        setEnhancedResult(response.data);
      } else {
        // Legacy mode
        const response = await axios.post<AnalysisResult>(
          `${API_BASE_URL}/api/mcp/analyze`,
          {
            repository: selectedRepo.full_name,
            token: token,
          },
          {
            headers: { 'Content-Type': 'application/json' },
          }
        );

        setLoadingState('generating');
        await new Promise(resolve => setTimeout(resolve, 300));

        setResult(response.data);
      }

      setLoadingState('idle');

    } catch (err) {
      setLoadingState('idle');
      if (axios.isAxiosError(err)) {
        setError(err.response?.data?.message || err.message || 'Analysis failed');
      } else {
        setError('An unexpected error occurred');
      }
    }
  }, [selectedRepo, token, analysisMode]);

  // NEW: Handle Dockerfile generation
  const handleGenerateDockerfile = useCallback(async () => {
    if (!selectedRepo || !token) return;

    setError(null);
    setDockerGenResult(null);

    try {
      setLoadingState('generating-dockerfile');

      const response = await axios.post<DockerfileGenerationResult>(
        `${API_BASE_URL}/api/mcp/generate/dockerfile`,
        {
          repository: selectedRepo.full_name,
          token: token,
        },
        {
          headers: { 'Content-Type': 'application/json' },
        }
      );

      setDockerGenResult(response.data);

      // If successful, update the enhanced result to reflect the new Dockerfile
      if (response.data.status === 'success' && enhancedResult) {
        setEnhancedResult({
          ...enhancedResult,
          repo_analysis_summary: {
            ...enhancedResult.repo_analysis_summary,
            has_dockerfile: true,
          },
          actionable_items: enhancedResult.actionable_items.map(item =>
            item.item === 'dockerfile'
              ? { ...item, is_present: true, action_required: false }
              : item
          ),
        });
      }

      setLoadingState('idle');

    } catch (err) {
      setLoadingState('idle');
      if (axios.isAxiosError(err)) {
        setError(err.response?.data?.message || err.message || 'Dockerfile generation failed');
      } else {
        setError('An unexpected error occurred during Dockerfile generation');
      }
    }
  }, [selectedRepo, token, enhancedResult]);

  // Filter repositories based on search
  const filteredRepos = repositories.filter(repo =>
    repo.full_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (repo.description?.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  // Loading messages
  const getLoadingMessage = (): string => {
    switch (loadingState) {
      case 'fetching-repos':
        return 'Loading your repositories...';
      case 'spawning':
        return 'Spawning MCP Server...';
      case 'analyzing':
        return analysisMode === 'enhanced'
          ? 'Running enhanced analysis...'
          : 'Analyzing repository files...';
      case 'generating':
        return 'Generating AI documentation...';
      case 'generating-dockerfile':
        return '🐳 Generating Dockerfile...';
      default:
        return '';
    }
  };

  const isLoading = loadingState !== 'idle';

  // ========== RENDER VIEWS ==========

  // View A: Connect Screen (Landing)
  if (view === 'connect') {
    return (
      <div className="app connect-view">
        <div className="connect-card">
          <div className="logo-section">
            <div className="logo-icon">
              <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M12 2L2 7L12 12L22 7L12 2Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M2 17L12 22L22 17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M2 12L12 17L22 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <h1 className="app-title">MCP Repository Analyzer</h1>
          </div>

          <p className="app-subtitle">
            Generate deep technical documentation for your GitHub Repositories using AI agents.
          </p>

          <div className="features-list">
            <div className="feature-item">
              <span className="feature-icon">🔍</span>
              <span>Tech Stack Detection</span>
            </div>
            <div className="feature-item">
              <span className="feature-icon">🐳</span>
              <span>Infrastructure Analysis</span>
            </div>
            <div className="feature-item">
              <span className="feature-icon">🤖</span>
              <span>AI Documentation</span>
            </div>
          </div>

          {error && (
            <div className="error-banner">
              <span className="error-icon">⚠️</span>
              {error}
            </div>
          )}

          <button className="connect-button" onClick={handleLogin}>
            <svg viewBox="0 0 24 24" fill="currentColor" className="github-icon">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
            </svg>
            Connect with GitHub
          </button>

          <p className="privacy-note">
            🔒 We only request read access to your repositories
          </p>
        </div>

        <div className="background-grid"></div>
      </div>
    );
  }

  // View B: Analyzer Dashboard
  return (
    <div className="app dashboard-view">
      {/* Header */}
      <header className="dashboard-header">
        <div className="header-left">
          <div className="header-logo">
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 2L2 7L12 12L22 7L12 2Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M2 17L12 22L22 17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M2 12L12 17L22 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <span className="header-title">MCP Analyzer</span>
        </div>

        <div className="header-right">
          {user && (
            <div className="user-info">
              {user.avatar && (
                <img src={user.avatar} alt={user.username} className="user-avatar" />
              )}
              <span className="username">{user.username}</span>
            </div>
          )}
          <button className="logout-button" onClick={handleLogout}>
            Logout
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="dashboard-main">
        {/* Repository Selection Section */}
        <section className="repo-section">
          <div className="section-header">
            <h2 className="section-title">📁 Select Repository</h2>
            <span className="repo-count">{repositories.length} repositories</span>
          </div>

          {/* Search Input */}
          <div className="search-container">
            <input
              type="text"
              className="search-input"
              placeholder="🔍 Search repositories..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              disabled={loadingState === 'fetching-repos'}
            />
            <button
              className="refresh-button"
              onClick={fetchRepositories}
              disabled={isLoading}
              title="Refresh repositories"
            >
              🔄
            </button>
          </div>

          {/* Loading State for Repos */}
          {loadingState === 'fetching-repos' && (
            <div className="repo-loading">
              <Loader message="Loading your repositories..." />
            </div>
          )}

          {/* Repository Grid */}
          {loadingState !== 'fetching-repos' && (
            <div className="repo-grid">
              {filteredRepos.map((repo) => (
                <div
                  key={repo.id}
                  className={`repo-card ${selectedRepo?.id === repo.id ? 'selected' : ''}`}
                  onClick={() => handleSelectRepo(repo)}
                >
                  <div className="repo-card-header">
                    <span className="repo-visibility">
                      {repo.private ? '🔒' : '🌐'}
                    </span>
                    <span className="repo-name">{repo.name}</span>
                  </div>
                  <p className="repo-description">
                    {repo.description || 'No description'}
                  </p>
                  <div className="repo-meta">
                    {repo.language && (
                      <span className="repo-language">
                        <span className="language-dot"></span>
                        {repo.language}
                      </span>
                    )}
                    <span className="repo-stars">⭐ {repo.stargazers_count}</span>
                    <span className="repo-forks">🔀 {repo.forks_count}</span>
                  </div>
                  <div className="repo-owner">
                    <img src={repo.owner.avatar_url} alt={repo.owner.login} className="owner-avatar" />
                    <span>{repo.owner.login}</span>
                  </div>
                </div>
              ))}

              {filteredRepos.length === 0 && repositories.length > 0 && (
                <div className="no-repos">
                  <p>No repositories match your search</p>
                </div>
              )}

              {repositories.length === 0 && (
                <div className="no-repos">
                  <p>No repositories found</p>
                  <button className="refresh-link" onClick={fetchRepositories}>
                    Refresh
                  </button>
                </div>
              )}
            </div>
          )}
        </section>

        {/* Selected Repository & Analyze */}
        {selectedRepo && (
          <section className="analyze-section">
            <div className="selected-repo-card">
              <div className="selected-repo-info">
                <h3>Selected Repository</h3>
                <div className="selected-repo-details">
                  <span className="selected-repo-name">{selectedRepo.full_name}</span>
                  {selectedRepo.language && (
                    <span className="selected-repo-lang">{selectedRepo.language}</span>
                  )}
                </div>
              </div>

              {/* Analysis Mode Toggle */}
              <div className="analysis-mode-toggle">
                <button
                  className={`mode-button ${analysisMode === 'enhanced' ? 'active' : ''}`}
                  onClick={() => setAnalysisMode('enhanced')}
                  disabled={isLoading}
                >
                  ✨ Enhanced
                </button>
                <button
                  className={`mode-button ${analysisMode === 'legacy' ? 'active' : ''}`}
                  onClick={() => setAnalysisMode('legacy')}
                  disabled={isLoading}
                >
                  📊 Legacy
                </button>
              </div>

              <button
                className="analyze-button"
                onClick={handleAnalyze}
                disabled={isLoading}
              >
                {isLoading && loadingState !== 'generating-dockerfile' ? 'Analyzing...' : '🚀 Analyze Repository'}
              </button>
            </div>

            {error && (
              <div className="error-message">
                <span className="error-icon">⚠️</span>
                {error}
              </div>
            )}
          </section>
        )}

        {/* Loading State for Analysis */}
        {(loadingState === 'spawning' || loadingState === 'analyzing' || loadingState === 'generating' || loadingState === 'generating-dockerfile') && (
          <section className="loading-section">
            <Loader message={getLoadingMessage()} />
          </section>
        )}

        {/* NEW: Enhanced Analysis Results */}
        {enhancedResult && !isLoading && analysisMode === 'enhanced' && (
          <section className="results-section enhanced-results">
            <div className="results-header">
              <h2 className="section-title">📊 Enhanced Analysis</h2>
              <div className="result-meta">
                <span className="repo-badge">{enhancedResult.repo_analysis_summary.repository_name}</span>
                <span className="duration-badge">⏱️ {enhancedResult.duration}</span>
              </div>
            </div>

            {/* Analysis Summary Component */}
            <AnalysisSummary summary={enhancedResult.repo_analysis_summary} />

            {/* Actionable Items */}
            <div className="actionable-items-section">
              <h3 className="subsection-title">🎯 Actionable Items</h3>
              <div className="actionable-items-grid">
                {enhancedResult.actionable_items.map((item) => (
                  <div
                    key={item.item}
                    className={`actionable-item ${item.is_present ? 'present' : 'missing'}`}
                  >
                    <div className="actionable-item-header">
                      <span className="item-icon">
                        {item.item === 'dockerfile' && '🐳'}
                        {item.item === 'dockerignore' && '📄'}
                        {item.item === 'readme' && '📝'}
                      </span>
                      <span className="item-name">{item.item}</span>
                      <span className={`item-status ${item.is_present ? 'found' : 'not-found'}`}>
                        {item.is_present ? '✅ Found' : '❌ Missing'}
                      </span>
                    </div>

                    {/* Show Generate Button for Dockerfile */}
                    {item.item === 'dockerfile' && item.action_required && (
                      <GenerateDockerButton
                        onGenerate={handleGenerateDockerfile}
                        isLoading={loadingState === 'generating-dockerfile'}
                        result={dockerGenResult}
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Dockerfile Generation Success */}
            {dockerGenResult?.status === 'success' && (
              <div className="dockerfile-success">
                <div className="success-header">
                  <span className="success-icon">✅</span>
                  <h3>Dockerfile Generated Successfully!</h3>
                </div>
                <p className="success-path">
                  📁 Created at: <code>{dockerGenResult.generated_file_path}</code>
                </p>
                {dockerGenResult.dockerfile_content && (
                  <div className="dockerfile-preview">
                    <h4>Generated Dockerfile:</h4>
                    <pre className="dockerfile-content">{dockerGenResult.dockerfile_content}</pre>
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {/* Legacy Results Section */}
        {result && !isLoading && analysisMode === 'legacy' && (
          <section className="results-section">
            <div className="results-header">
              <h2 className="section-title">📊 Analysis Result</h2>
              <div className="result-meta">
                <span className="repo-badge">{result.repository}</span>
                <span className="duration-badge">⏱️ {result.duration}</span>
              </div>
            </div>

            {/* Quick Stats */}
            <div className="stats-grid">
              <div className="stat-card">
                <span className="stat-icon">📁</span>
                <div className="stat-content">
                  <span className="stat-value">{result.analysis?.filesAnalyzed?.length || 0}</span>
                  <span className="stat-label">Files Analyzed</span>
                </div>
              </div>
              <div className="stat-card">
                <span className="stat-icon">🚀</span>
                <div className="stat-content">
                  <span className="stat-value">
                    {result.analysis?.detected?.frameworks?.length || 0}
                  </span>
                  <span className="stat-label">Frameworks</span>
                </div>
              </div>
              <div className="stat-card">
                <span className="stat-icon">🐳</span>
                <div className="stat-content">
                  <span className="stat-value">
                    {result.analysis?.detected?.docker?.exists ? 'Yes' : 'No'}
                  </span>
                  <span className="stat-label">Docker</span>
                </div>
              </div>
              <div className="stat-card">
                <span className="stat-icon">⚙️</span>
                <div className="stat-content">
                  <span className="stat-value">
                    {result.analysis?.detected?.cicd?.configured ? 'Yes' : 'No'}
                  </span>
                  <span className="stat-label">CI/CD</span>
                </div>
              </div>
            </div>

            {/* AI Documentation */}
            {result.documentation && (
              <div className="documentation-section">
                <h3 className="subsection-title">📝 AI Generated Documentation</h3>
                <div className="documentation-content">
                  <pre>{result.documentation}</pre>
                </div>
              </div>
            )}

            {/* Raw JSON */}
            <div className="json-section">
              <h3 className="subsection-title">🔍 Raw Analysis Data</h3>
              <JsonDisplay data={result.raw} />
            </div>
          </section>
        )}
      </main>

      <div className="background-grid"></div>
    </div>
  );
}

export default App;
