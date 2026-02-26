import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import api from '../services/api';

export default function ContractList() {
  const { user } = useAuth();
  const [contracts, setContracts] = useState([]);
  const [showCreate, setShowCreate] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => { loadContracts(); }, []);

  const loadContracts = async () => {
    try { setContracts(await api.getContracts()); } catch (err) { console.error(err); }
  };

  const filtered = contracts.filter(c =>
    c.title.toLowerCase().includes(search.toLowerCase()) ||
    (c.description || '').toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div>
      <div className="flex-between mb-4">
        <h1 style={{ fontSize: 24, fontWeight: 700 }}>Contracts</h1>
        {(user?.role === 'admin' || user?.role === 'editor') && (
          <button className="btn btn-primary" onClick={() => setShowCreate(true)}>+ New Contract</button>
        )}
      </div>

      <div className="card mb-4">
        <div className="card-body" style={{ padding: '12px 16px' }}>
          <input className="form-control" placeholder="Search contracts..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="card"><div className="card-body empty-state"><h3>No contracts found</h3><p>Create your first contract to get started</p></div></div>
      ) : (
        <div className="grid grid-2">
          {filtered.map(c => (
            <Link to={`/contracts/${c.id}`} key={c.id} style={{ textDecoration: 'none', color: 'inherit' }}>
              <div className="card" style={{ cursor: 'pointer', transition: 'box-shadow 0.15s' }}>
                <div className="card-body">
                  <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>{c.title}</h3>
                  {c.description && <p className="text-sm text-muted" style={{ marginBottom: 12 }}>{c.description.slice(0, 120)}{c.description.length > 120 ? '...' : ''}</p>}
                  <div className="flex-between text-sm text-muted">
                    <div>
                      {c.proposal_count} proposal{c.proposal_count !== 1 ? 's' : ''} · {c.version_count} version{c.version_count !== 1 ? 's' : ''}
                    </div>
                    <div>by {c.created_by_name}</div>
                  </div>
                  {c.original_filename && (
                    <div className="text-sm text-muted mt-2">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ verticalAlign: 'middle', marginRight: 4 }}>
                        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/>
                      </svg>
                      {c.original_filename}
                    </div>
                  )}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      {showCreate && <CreateContractModal onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); loadContracts(); }} />}
    </div>
  );
}

function CreateContractModal({ onClose, onCreated }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [file, setFile] = useState(null);
  const [manualMode, setManualMode] = useState(false);
  const [sections, setSections] = useState([{ number: '1', title: '', content: '' }]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const addSection = () => setSections([...sections, { number: String(sections.length + 1), title: '', content: '' }]);
  const updateSection = (i, field, value) => {
    const s = [...sections];
    s[i][field] = value;
    setSections(s);
  };
  const removeSection = (i) => setSections(sections.filter((_, idx) => idx !== i));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!title) return setError('Title is required');
    setLoading(true);
    setError('');
    try {
      const formData = new FormData();
      formData.append('title', title);
      formData.append('description', description);
      if (file) formData.append('file', file);
      if (manualMode) formData.append('sections', JSON.stringify(sections));
      await api.createContract(formData);
      onCreated();
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 800 }}>
        <div className="modal-header">
          <h2>Create New Contract</h2>
          <button className="btn-ghost" onClick={onClose}>&#x2715;</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {error && <div className="login-error">{error}</div>}
            <div className="form-group">
              <label>Title *</label>
              <input className="form-control" value={title} onChange={e => setTitle(e.target.value)} placeholder="Contract title" required />
            </div>
            <div className="form-group">
              <label>Description</label>
              <textarea className="form-control" value={description} onChange={e => setDescription(e.target.value)} placeholder="Brief description" rows={2} />
            </div>

            <div className="tabs" style={{ marginBottom: 16 }}>
              <button type="button" className={`tab ${!manualMode ? 'active' : ''}`} onClick={() => setManualMode(false)}>Upload File</button>
              <button type="button" className={`tab ${manualMode ? 'active' : ''}`} onClick={() => setManualMode(true)}>Manual Entry</button>
            </div>

            {!manualMode ? (
              <div className="form-group">
                <label>Contract File (PDF, DOCX, TXT)</label>
                <input type="file" className="form-control" accept=".pdf,.docx,.doc,.txt" onChange={e => setFile(e.target.files[0])} />
                <p className="text-sm text-muted mt-2">The file will be parsed into editable sections automatically.</p>
              </div>
            ) : (
              <div>
                {sections.map((s, i) => (
                  <div key={i} style={{ border: '1px solid var(--gray-200)', borderRadius: 'var(--radius)', padding: 16, marginBottom: 12 }}>
                    <div className="flex-between mb-3">
                      <strong className="text-sm">Section {i + 1}</strong>
                      {sections.length > 1 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => removeSection(i)}>Remove</button>}
                    </div>
                    <div className="flex gap-2 mb-3">
                      <input className="form-control" placeholder="Number (e.g. 1.1)" value={s.number} onChange={e => updateSection(i, 'number', e.target.value)} style={{ maxWidth: 120 }} />
                      <input className="form-control" placeholder="Section title" value={s.title} onChange={e => updateSection(i, 'title', e.target.value)} />
                    </div>
                    <textarea className="form-control" placeholder="Section content" value={s.content} onChange={e => updateSection(i, 'content', e.target.value)} rows={4} />
                  </div>
                ))}
                <button type="button" className="btn btn-outline btn-sm" onClick={addSection}>+ Add Section</button>
              </div>
            )}
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={loading}>{loading ? 'Creating...' : 'Create Contract'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
