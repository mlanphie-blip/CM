import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import api from '../services/api';

export default function ApprovalDashboard() {
  const [dashboard, setDashboard] = useState({ pendingReviews: [], myDecisions: [], allPending: [] });
  const [activeTab, setActiveTab] = useState('pending');

  useEffect(() => {
    api.getDashboard().then(setDashboard).catch(console.error);
  }, []);

  return (
    <div>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 20 }}>Approval Dashboard</h1>

      <div className="grid grid-3 mb-4">
        <div className="card stat-card">
          <div className="stat-value" style={{ color: 'var(--warning)' }}>{dashboard.pendingReviews.length}</div>
          <div className="stat-label">Your Pending Reviews</div>
        </div>
        <div className="card stat-card">
          <div className="stat-value">{dashboard.myDecisions.length}</div>
          <div className="stat-label">Your Completed Reviews</div>
        </div>
        <div className="card stat-card">
          <div className="stat-value">{dashboard.allPending.length}</div>
          <div className="stat-label">Total Under Review</div>
        </div>
      </div>

      <div className="tabs">
        <button className={`tab ${activeTab === 'pending' ? 'active' : ''}`} onClick={() => setActiveTab('pending')}>
          Your Pending Reviews ({dashboard.pendingReviews.length})
        </button>
        <button className={`tab ${activeTab === 'decisions' ? 'active' : ''}`} onClick={() => setActiveTab('decisions')}>
          Your Past Decisions ({dashboard.myDecisions.length})
        </button>
        <button className={`tab ${activeTab === 'all' ? 'active' : ''}`} onClick={() => setActiveTab('all')}>
          All Under Review ({dashboard.allPending.length})
        </button>
      </div>

      {activeTab === 'pending' && (
        <div>
          {dashboard.pendingReviews.length === 0 ? (
            <div className="card"><div className="card-body empty-state"><h3>No pending reviews</h3><p>You're all caught up!</p></div></div>
          ) : (
            <div className="card">
              <div className="table-container">
                <table>
                  <thead><tr><th>Proposal</th><th>Contract</th><th>Proposer</th><th>Required</th><th>Action</th></tr></thead>
                  <tbody>
                    {dashboard.pendingReviews.map(r => (
                      <tr key={r.id}>
                        <td><Link to={`/proposals/${r.proposal_id}`} style={{ fontWeight: 600 }}>{r.proposal_title}</Link></td>
                        <td className="text-sm">{r.contract_title}</td>
                        <td className="text-sm">{r.proposer_name}</td>
                        <td>{r.required ? <span className="status-badge status-under_review">Required</span> : <span className="text-sm text-muted">Optional</span>}</td>
                        <td><Link to={`/proposals/${r.proposal_id}`} className="btn btn-primary btn-sm">Review</Link></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === 'decisions' && (
        <div className="card">
          {dashboard.myDecisions.length === 0 ? (
            <div className="card-body empty-state"><h3>No decisions yet</h3></div>
          ) : (
            <div className="table-container">
              <table>
                <thead><tr><th>Proposal</th><th>Contract</th><th>Decision</th><th>Comments</th><th>Date</th></tr></thead>
                <tbody>
                  {dashboard.myDecisions.map(d => (
                    <tr key={d.id}>
                      <td><Link to={`/proposals/${d.proposal_id}`} style={{ fontWeight: 600 }}>{d.proposal_title}</Link></td>
                      <td className="text-sm">{d.contract_title}</td>
                      <td><span className={`status-badge status-${d.decision}`}>{d.decision}</span></td>
                      <td className="text-sm">{d.comments || '-'}</td>
                      <td className="text-sm text-muted">{d.decided_at ? new Date(d.decided_at).toLocaleDateString() : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {activeTab === 'all' && (
        <div className="card">
          {dashboard.allPending.length === 0 ? (
            <div className="card-body empty-state"><h3>No proposals under review</h3></div>
          ) : (
            <div className="table-container">
              <table>
                <thead><tr><th>Proposal</th><th>Contract</th><th>Proposer</th><th>Approvals</th><th>Rejections</th><th>Pending</th></tr></thead>
                <tbody>
                  {dashboard.allPending.map(p => (
                    <tr key={p.id}>
                      <td><Link to={`/proposals/${p.id}`} style={{ fontWeight: 600 }}>{p.title}</Link></td>
                      <td className="text-sm">{p.contract_title}</td>
                      <td className="text-sm">{p.proposer_name}</td>
                      <td><span style={{ color: 'var(--success)', fontWeight: 600 }}>{p.approvals}</span></td>
                      <td><span style={{ color: 'var(--danger)', fontWeight: 600 }}>{p.rejections}</span></td>
                      <td><span style={{ color: 'var(--warning)', fontWeight: 600 }}>{p.pending}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
