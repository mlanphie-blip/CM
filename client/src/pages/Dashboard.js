import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import api from '../services/api';

export default function Dashboard() {
  const { user } = useAuth();
  const [stats, setStats] = useState({ contracts: 0, proposals: 0, pending: 0, approved: 0 });
  const [recentProposals, setRecentProposals] = useState([]);
  const [activity, setActivity] = useState([]);
  const [pendingReviews, setPendingReviews] = useState([]);

  useEffect(() => {
    loadDashboard();
  }, []);

  const loadDashboard = async () => {
    try {
      const [contracts, proposals, dashboard, activityData] = await Promise.all([
        api.getContracts(),
        api.getProposals(),
        api.getDashboard(),
        api.getActivity(15)
      ]);
      setStats({
        contracts: contracts.length,
        proposals: proposals.length,
        pending: proposals.filter(p => p.status === 'under_review').length,
        approved: proposals.filter(p => p.status === 'approved').length
      });
      setRecentProposals(proposals.slice(0, 5));
      setActivity(activityData);
      setPendingReviews(dashboard.pendingReviews || []);
    } catch (err) {
      console.error('Dashboard load error:', err);
    }
  };

  const formatDate = (d) => {
    if (!d) return '';
    const date = new Date(d + (d.includes('T') ? '' : 'T00:00:00'));
    const now = new Date();
    const diff = now - date;
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff/60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff/3600000)}h ago`;
    return date.toLocaleDateString();
  };

  return (
    <div>
      <div className="flex-between mb-4">
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700 }}>Welcome, {user?.full_name}</h1>
          <p className="text-muted text-sm">Here's your contract amendment overview</p>
        </div>
        <div className="flex gap-2">
          <Link to="/contracts" className="btn btn-primary">View Contracts</Link>
          <Link to="/proposals" className="btn btn-outline">View Proposals</Link>
        </div>
      </div>

      <div className="grid grid-4 mb-4">
        <div className="card stat-card">
          <div className="stat-value">{stats.contracts}</div>
          <div className="stat-label">Total Contracts</div>
        </div>
        <div className="card stat-card">
          <div className="stat-value">{stats.proposals}</div>
          <div className="stat-label">Total Proposals</div>
        </div>
        <div className="card stat-card">
          <div className="stat-value" style={{ color: 'var(--warning)' }}>{stats.pending}</div>
          <div className="stat-label">Under Review</div>
        </div>
        <div className="card stat-card">
          <div className="stat-value" style={{ color: 'var(--success)' }}>{stats.approved}</div>
          <div className="stat-label">Approved</div>
        </div>
      </div>

      <div className="grid grid-2">
        <div>
          {pendingReviews.length > 0 && (
            <div className="card mb-4">
              <div className="card-header"><h3>Your Pending Reviews</h3></div>
              <div className="card-body">
                {pendingReviews.map(r => (
                  <div key={r.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--gray-100)' }}>
                    <Link to={`/proposals/${r.proposal_id}`} style={{ fontWeight: 600, fontSize: 14 }}>{r.proposal_title}</Link>
                    <div className="text-sm text-muted">{r.contract_title} — by {r.proposer_name}</div>
                    {r.required ? <span className="status-badge status-under_review" style={{ marginTop: 4 }}>Required</span> : null}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="card">
            <div className="card-header">
              <h3>Recent Proposals</h3>
              <Link to="/proposals" className="btn btn-ghost btn-sm">View All</Link>
            </div>
            <div className="card-body">
              {recentProposals.length === 0 ? (
                <div className="empty-state"><p>No proposals yet</p></div>
              ) : (
                recentProposals.map(p => (
                  <div key={p.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--gray-100)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <Link to={`/proposals/${p.id}`} style={{ fontWeight: 600, fontSize: 14 }}>{p.title}</Link>
                      <div className="text-sm text-muted">{p.contract_title} — {p.proposer_name}</div>
                    </div>
                    <span className={`status-badge status-${p.status}`}>{p.status.replace('_', ' ')}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h3>Recent Activity</h3>
            <Link to="/activity" className="btn btn-ghost btn-sm">View All</Link>
          </div>
          <div className="card-body">
            {activity.length === 0 ? (
              <div className="empty-state"><p>No recent activity</p></div>
            ) : (
              <div className="timeline">
                {activity.map(a => (
                  <div key={a.id} className="timeline-item">
                    <div className="timeline-date">{formatDate(a.created_at)}</div>
                    <div className="timeline-content">
                      <span className="timeline-actor">{a.user_name || 'System'}</span>
                      {' '}{formatAction(a.action)} {a.entity_type}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function formatAction(action) {
  const map = {
    create_contract: 'created a',
    update_sections: 'updated sections in',
    create_version: 'created a version of',
    create_proposal: 'proposed an amendment to',
    update_proposal: 'updated a',
    submit_proposal: 'submitted a',
    apply_proposal: 'applied a',
    add_feedback: 'commented on a',
    approval_decision: 'reviewed a',
    assign_reviewer: 'assigned reviewer for',
    rollback: 'rolled back a',
    export_redline: 'exported redline of',
    export_clean: 'exported clean version of',
    export_docx: 'exported DOCX of',
    login: 'logged in as',
  };
  return map[action] || action.replace(/_/g, ' ');
}
