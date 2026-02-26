import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import api from '../services/api';

export default function ProposalList() {
  const [proposals, setProposals] = useState([]);
  const [filters, setFilters] = useState({ status: '', search: '', contract_id: '' });
  const [contracts, setContracts] = useState([]);

  useEffect(() => {
    api.getContracts().then(setContracts).catch(() => {});
    loadProposals();
  }, []);

  useEffect(() => { loadProposals(); }, [filters]);

  const loadProposals = async () => {
    try {
      const params = {};
      if (filters.status) params.status = filters.status;
      if (filters.search) params.search = filters.search;
      if (filters.contract_id) params.contract_id = filters.contract_id;
      setProposals(await api.getProposals(params));
    } catch (err) { console.error(err); }
  };

  return (
    <div>
      <div className="flex-between mb-4">
        <h1 style={{ fontSize: 24, fontWeight: 700 }}>Amendment Proposals</h1>
      </div>

      <div className="card mb-4">
        <div className="card-body" style={{ padding: '12px 16px' }}>
          <div className="filters">
            <div className="form-group">
              <label>Search</label>
              <input className="form-control" placeholder="Search proposals..." value={filters.search} onChange={e => setFilters({ ...filters, search: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Status</label>
              <select className="form-control" value={filters.status} onChange={e => setFilters({ ...filters, status: e.target.value })}>
                <option value="">All Statuses</option>
                <option value="draft">Draft</option>
                <option value="under_review">Under Review</option>
                <option value="approved">Approved</option>
                <option value="rejected">Rejected</option>
                <option value="withdrawn">Withdrawn</option>
              </select>
            </div>
            <div className="form-group">
              <label>Contract</label>
              <select className="form-control" value={filters.contract_id} onChange={e => setFilters({ ...filters, contract_id: e.target.value })}>
                <option value="">All Contracts</option>
                {contracts.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
              </select>
            </div>
            {(filters.status || filters.search || filters.contract_id) && (
              <button className="btn btn-ghost btn-sm" onClick={() => setFilters({ status: '', search: '', contract_id: '' })}>Clear Filters</button>
            )}
          </div>
        </div>
      </div>

      {proposals.length === 0 ? (
        <div className="card"><div className="card-body empty-state"><h3>No proposals found</h3><p>Proposals will appear here once created</p></div></div>
      ) : (
        <div className="card">
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Contract</th>
                  <th>Section</th>
                  <th>Status</th>
                  <th>Priority</th>
                  <th>Proposer</th>
                  <th>Feedback</th>
                  <th>Approvals</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {proposals.map(p => (
                  <tr key={p.id}>
                    <td><Link to={`/proposals/${p.id}`} style={{ fontWeight: 600 }}>{p.title}</Link></td>
                    <td className="text-sm"><Link to={`/contracts/${p.contract_id}`}>{p.contract_title}</Link></td>
                    <td className="text-sm">{p.section_number ? `${p.section_number}` : '-'}</td>
                    <td><span className={`status-badge status-${p.status}`}>{p.status.replace('_', ' ')}</span></td>
                    <td><span className={`priority-${p.priority || 'medium'} text-sm`} style={{ fontWeight: 600 }}>{p.priority || 'medium'}</span></td>
                    <td className="text-sm">{p.proposer_name}</td>
                    <td className="text-sm">{p.feedback_count}</td>
                    <td className="text-sm">
                      <span style={{ color: 'var(--success)' }}>{p.approval_count}</span>
                      {p.rejection_count > 0 && <> / <span style={{ color: 'var(--danger)' }}>{p.rejection_count}</span></>}
                    </td>
                    <td className="text-sm text-muted">{new Date(p.created_at).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
