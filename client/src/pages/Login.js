import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';

export default function Login() {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(username, password);
    } catch (err) {
      setError(err.message || 'Login failed');
    }
    setLoading(false);
  };

  return (
    <div className="login-page">
      <div className="card login-card">
        <div className="card-header">
          <h2>Contract Amendment Manager</h2>
          <p>Sign in to manage your contracts</p>
        </div>
        <div className="card-body">
          {error && <div className="login-error">{error}</div>}
          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label>Username</label>
              <input className="form-control" value={username} onChange={e => setUsername(e.target.value)} placeholder="Enter username" required />
            </div>
            <div className="form-group">
              <label>Password</label>
              <input className="form-control" type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Enter password" required />
            </div>
            <button className="btn btn-primary w-full btn-lg" type="submit" disabled={loading}>
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
          </form>
          <div style={{ marginTop: 20, padding: 16, background: 'var(--gray-50)', borderRadius: 'var(--radius)', fontSize: 13 }}>
            <strong>Demo Accounts:</strong>
            <div style={{ marginTop: 8 }}>
              <div><code>admin / admin123</code> — Administrator</div>
              <div><code>editor / editor123</code> — Editor</div>
              <div><code>reviewer / reviewer123</code> — Reviewer</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
