import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import api from '../services/api';

export default function ContractDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [contract, setContract] = useState(null);
  const [activeTab, setActiveTab] = useState('document');
  const [showProposalForm, setShowProposalForm] = useState(false);
  const [selectedText, setSelectedText] = useState('');
  const [proposals, setProposals] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [showVersionForm, setShowVersionForm] = useState(false);
  const [error, setError] = useState('');
  const [selectionPos, setSelectionPos] = useState(null);
  const docRef = useRef(null);

  const loadContract = useCallback(async () => {
    try {
      const data = await api.getContract(id);
      setContract(data);
    } catch (err) { setError(err.message); }
  }, [id]);

  const loadProposals = useCallback(async () => {
    try { setProposals(await api.getProposals({ contract_id: id })); } catch {}
  }, [id]);

  useEffect(() => {
    loadContract();
    loadProposals();
    api.getTemplates().then(setTemplates).catch(() => {});
  }, [loadContract, loadProposals]);

  const handleDelete = async () => {
    if (!window.confirm('Delete this contract and all related data?')) return;
    try { await api.deleteContract(id); navigate('/contracts'); } catch (err) { setError(err.message); }
  };

  const handleReparse = async () => {
    if (!window.confirm('Re-parse this contract from the original file? This will regenerate the document text.')) return;
    try {
      const result = await api.reparseContract(id);
      alert(result.message || 'Re-parsed successfully');
      loadContract();
    } catch (err) { setError(err.message); }
  };

  const handleExport = (type) => {
    const token = localStorage.getItem('token');
    let url;
    if (type === 'redline') url = api.getRedlineUrl(id);
    else if (type === 'clean') url = api.getCleanUrl(id);
    else if (type === 'docx-clean') url = api.getDocxUrl(id, 'clean');
    else if (type === 'docx-redline') url = api.getDocxUrl(id, 'redline');
    window.open(url + (url.includes('?') ? '&' : '?') + 'token=' + token, '_blank');
  };

  // Handle text selection in the document view
  const handleMouseUp = useCallback(() => {
    const sel = window.getSelection();
    const text = sel?.toString()?.trim();
    if (text && text.length > 0 && docRef.current?.contains(sel?.anchorNode)) {
      setSelectedText(text);
      // Position the floating button near the selection
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      const containerRect = docRef.current.getBoundingClientRect();
      setSelectionPos({
        top: rect.top - containerRect.top - 40,
        left: Math.min(rect.left - containerRect.left + rect.width / 2, containerRect.width - 100)
      });
    } else {
      // Don't clear selection if the proposal form is open
      if (!showProposalForm) {
        setSelectedText('');
        setSelectionPos(null);
      }
    }
  }, [showProposalForm]);

  const openProposalWithSelection = () => {
    setShowProposalForm(true);
    setSelectionPos(null);
  };

  if (error && !contract) return <div className="card"><div className="card-body"><p style={{ color: 'var(--danger)' }}>{error}</p></div></div>;
  if (!contract) return <div className="flex-center" style={{ padding: 60 }}>Loading...</div>;

  const canEdit = user?.role === 'admin' || user?.role === 'editor';
  // Combine all sections into one document text
  const fullText = contract.sections.map(s => s.content).join('\n\n');
  const firstSection = contract.sections[0];

  return (
    <div>
      <div className="flex-between mb-4">
        <div>
          <Link to="/contracts" className="text-sm text-muted">&larr; Back to Contracts</Link>
          <h1 style={{ fontSize: 24, fontWeight: 700, marginTop: 4 }}>{contract.title}</h1>
          {contract.description && <p className="text-muted text-sm">{contract.description}</p>}
        </div>
        <div className="flex gap-2">
          {canEdit && <button className="btn btn-outline btn-sm" onClick={() => setShowVersionForm(true)}>Save Version</button>}
          {canEdit && contract.file_path && <button className="btn btn-outline btn-sm" onClick={handleReparse}>Re-parse</button>}
          <div style={{ position: 'relative', display: 'inline-block' }}>
            <ExportMenu onExport={handleExport} />
          </div>
          {user?.role === 'admin' && <button className="btn btn-danger btn-sm" onClick={handleDelete}>Delete</button>}
        </div>
      </div>

      {error && <div className="login-error mb-4">{error}</div>}

      <div className="tabs">
        <button className={`tab ${activeTab === 'document' ? 'active' : ''}`} onClick={() => setActiveTab('document')}>Document</button>
        <button className={`tab ${activeTab === 'proposals' ? 'active' : ''}`} onClick={() => setActiveTab('proposals')}>
          Proposals ({proposals.length})
        </button>
        <button className={`tab ${activeTab === 'versions' ? 'active' : ''}`} onClick={() => setActiveTab('versions')}>
          Versions ({contract.versions?.length || 0})
        </button>
      </div>

      {activeTab === 'document' && (
        <div>
          {canEdit && (
            <div style={{ background: 'var(--gray-50)', border: '1px solid var(--gray-200)', borderRadius: 'var(--radius)', padding: '10px 16px', marginBottom: 16, fontSize: 14, color: 'var(--gray-600)' }}>
              Highlight text in the document below, then click <strong>"Propose Amendment"</strong> to create a change proposal for the selected clause(s).
            </div>
          )}
          <div className="card">
            <div className="card-body" style={{ position: 'relative' }}>
              {/* Floating "Propose Amendment" button appears when text is selected */}
              {canEdit && selectionPos && selectedText && (
                <button
                  className="btn btn-primary btn-sm"
                  style={{
                    position: 'absolute',
                    top: selectionPos.top,
                    left: selectionPos.left,
                    zIndex: 20,
                    boxShadow: 'var(--shadow-md)',
                    transform: 'translateX(-50%)',
                    whiteSpace: 'nowrap'
                  }}
                  onMouseDown={e => e.preventDefault()}
                  onClick={openProposalWithSelection}
                >
                  Propose Amendment
                </button>
              )}
              <div
                ref={docRef}
                onMouseUp={handleMouseUp}
                className="contract-document"
                style={{
                  lineHeight: 1.8,
                  fontSize: 14,
                  maxHeight: '70vh',
                  overflow: 'auto',
                  padding: '8px 16px',
                  cursor: 'text',
                  userSelect: 'text'
                }}
                dangerouslySetInnerHTML={{ __html: fullText }}
              />
            </div>
          </div>
          {proposals.length > 0 && (
            <div style={{ marginTop: 24 }}>
              <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>Active Proposals</h3>
              {proposals.map(p => (
                <div key={p.id} className="card mb-2">
                  <div className="card-body" style={{ padding: '12px 16px' }}>
                    <div className="flex-between">
                      <Link to={`/proposals/${p.id}`} style={{ fontWeight: 600 }}>{p.title}</Link>
                      <span className={`status-badge status-${p.status}`}>{p.status.replace('_', ' ')}</span>
                    </div>
                    {p.original_text && (
                      <p className="text-sm text-muted" style={{ marginTop: 4 }}>
                        Amending: "{p.original_text.substring(0, 100)}{p.original_text.length > 100 ? '...' : ''}"
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'proposals' && (
        <div>
          {canEdit && <button className="btn btn-primary btn-sm mb-3" onClick={() => { setSelectedText(''); setShowProposalForm(true); }}>+ New Proposal</button>}
          {proposals.length === 0 ? (
            <div className="card"><div className="card-body empty-state"><h3>No proposals yet</h3><p className="text-muted">Highlight text in the Document tab to propose amendments</p></div></div>
          ) : (
            <div className="card">
              <div className="table-container">
                <table>
                  <thead><tr><th>Title</th><th>Status</th><th>Proposer</th><th>Feedback</th><th>Date</th></tr></thead>
                  <tbody>
                    {proposals.map(p => (
                      <tr key={p.id}>
                        <td><Link to={`/proposals/${p.id}`} style={{ fontWeight: 600 }}>{p.title}</Link></td>
                        <td><span className={`status-badge status-${p.status}`}>{p.status.replace('_', ' ')}</span></td>
                        <td className="text-sm">{p.proposer_name}</td>
                        <td className="text-sm">{p.feedback_count} comments</td>
                        <td className="text-sm text-muted">{new Date(p.created_at).toLocaleDateString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === 'versions' && (
        <div>
          {canEdit && <button className="btn btn-outline btn-sm mb-3" onClick={() => setShowVersionForm(true)}>+ Save New Version</button>}
          {contract.versions?.length > 1 && (
            <Link to={`/contracts/${id}/compare`} className="btn btn-outline btn-sm mb-3" style={{ marginLeft: 8 }}>Compare Versions</Link>
          )}
          <div className="card">
            <div className="table-container">
              <table>
                <thead><tr><th>Version</th><th>Label</th><th>Summary</th><th>Branch</th><th>By</th><th>Date</th><th></th></tr></thead>
                <tbody>
                  {(contract.versions || []).map(v => (
                    <tr key={v.id}>
                      <td><strong>v{v.version_number}</strong></td>
                      <td>{v.version_label}</td>
                      <td className="text-sm">{v.change_summary}</td>
                      <td><span className="status-badge status-draft">{v.branch_name || 'main'}</span></td>
                      <td className="text-sm">{v.created_by_name}</td>
                      <td className="text-sm text-muted">{new Date(v.created_at).toLocaleDateString()}</td>
                      <td>
                        {user?.role === 'admin' && v.version_number !== contract.versions[0]?.version_number && (
                          <button className="btn btn-ghost btn-sm" onClick={async () => {
                            if (window.confirm(`Rollback to version ${v.version_number}?`)) {
                              await api.rollback(id, v.id);
                              loadContract();
                            }
                          }}>Rollback</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {showProposalForm && (
        <ProposalFormModal
          contractId={id}
          sectionId={firstSection?.id}
          initialOriginalText={selectedText}
          templates={templates}
          onClose={() => { setShowProposalForm(false); }}
          onCreated={() => { setShowProposalForm(false); setSelectedText(''); setSelectionPos(null); loadProposals(); }}
        />
      )}

      {showVersionForm && (
        <VersionFormModal
          contractId={id}
          onClose={() => setShowVersionForm(false)}
          onCreated={() => { setShowVersionForm(false); loadContract(); }}
        />
      )}
    </div>
  );
}

function ExportMenu({ onExport }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <button className="btn btn-outline btn-sm" onClick={() => setOpen(!open)}>Export &#9662;</button>
      {open && (
        <div style={{ position: 'absolute', right: 0, top: '100%', background: 'white', border: '1px solid var(--gray-200)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-md)', zIndex: 10, minWidth: 180, padding: 4, marginTop: 4 }}>
          <button className="btn btn-ghost w-full" style={{ justifyContent: 'flex-start' }} onClick={() => { onExport('redline'); setOpen(false); }}>Redline (HTML)</button>
          <button className="btn btn-ghost w-full" style={{ justifyContent: 'flex-start' }} onClick={() => { onExport('clean'); setOpen(false); }}>Clean (HTML)</button>
          <button className="btn btn-ghost w-full" style={{ justifyContent: 'flex-start' }} onClick={() => { onExport('docx-clean'); setOpen(false); }}>Clean (DOCX)</button>
          <button className="btn btn-ghost w-full" style={{ justifyContent: 'flex-start' }} onClick={() => { onExport('docx-redline'); setOpen(false); }}>Redline (DOCX)</button>
        </div>
      )}
    </div>
  );
}

function ProposalFormModal({ contractId, sectionId, initialOriginalText, templates, onClose, onCreated }) {
  const [title, setTitle] = useState('');
  const [originalText, setOriginalText] = useState(initialOriginalText || '');
  const [proposedText, setProposedText] = useState(initialOriginalText || '');
  const [rationale, setRationale] = useState('');
  const [priority, setPriority] = useState('medium');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const applyTemplate = (template) => {
    setTitle(template.name);
    setProposedText(template.template_text);
    setRationale(`Based on template: ${template.name} - ${template.description}`);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      await api.createProposal({
        contract_id: contractId,
        section_id: sectionId || null,
        title,
        original_text: originalText,
        proposed_text: proposedText,
        rationale,
        priority
      });
      onCreated();
    } catch (err) { setError(err.message); }
    setLoading(false);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 960 }}>
        <div className="modal-header">
          <h2>Propose Amendment</h2>
          <button className="btn-ghost" onClick={onClose}>&#x2715;</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {error && <div className="login-error">{error}</div>}
            <div className="flex gap-3">
              <div className="form-group" style={{ flex: 2 }}>
                <label>Title *</label>
                <input className="form-control" value={title} onChange={e => setTitle(e.target.value)} required placeholder="e.g. Update Section 1.2 - Contractor Responsibilities" />
              </div>
              <div className="form-group" style={{ flex: 1 }}>
                <label>Priority</label>
                <select className="form-control" value={priority} onChange={e => setPriority(e.target.value)}>
                  <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option>
                </select>
              </div>
            </div>
            {templates.length > 0 && (
              <div className="form-group">
                <label>Apply Template</label>
                <select className="form-control" onChange={e => { const t = templates.find(t => String(t.id) === e.target.value); if (t) applyTemplate(t); }}>
                  <option value="">-- Select Template (optional) --</option>
                  {templates.map(t => <option key={t.id} value={t.id}>{t.name} ({t.category})</option>)}
                </select>
              </div>
            )}
            <div className="diff-container mb-3">
              <div className="diff-side">
                <div className="diff-side-header">Original Text (from contract)</div>
                <div style={{ padding: 8 }}>
                  <textarea
                    className="form-control"
                    value={originalText}
                    onChange={e => setOriginalText(e.target.value)}
                    rows={12}
                    placeholder="Paste or highlight text from the contract document"
                    style={{ fontFamily: '"Courier New", Courier, monospace', fontSize: 13, lineHeight: 1.6 }}
                  />
                </div>
              </div>
              <div className="diff-side">
                <div className="diff-side-header">Proposed Text (your changes)</div>
                <div style={{ padding: 8 }}>
                  <textarea
                    className="form-control"
                    value={proposedText}
                    onChange={e => setProposedText(e.target.value)}
                    rows={12}
                    placeholder="Edit this text to show your proposed changes"
                    style={{ fontFamily: '"Courier New", Courier, monospace', fontSize: 13, lineHeight: 1.6 }}
                  />
                </div>
              </div>
            </div>
            <div className="form-group">
              <label>Rationale / Justification</label>
              <textarea className="form-control" value={rationale} onChange={e => setRationale(e.target.value)} rows={3} placeholder="Why is this change needed?" />
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={loading}>{loading ? 'Creating...' : 'Create Proposal'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function VersionFormModal({ contractId, onClose, onCreated }) {
  const [label, setLabel] = useState('');
  const [summary, setSummary] = useState('');
  const [branch, setBranch] = useState('main');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await api.createVersion(contractId, { version_label: label, change_summary: summary, branch_name: branch });
      onCreated();
    } catch (err) { alert(err.message); }
    setLoading(false);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header"><h2>Save Version</h2><button className="btn-ghost" onClick={onClose}>&#x2715;</button></div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <div className="form-group"><label>Version Label</label><input className="form-control" value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Draft 2" /></div>
            <div className="form-group"><label>Change Summary</label><textarea className="form-control" value={summary} onChange={e => setSummary(e.target.value)} placeholder="What changed?" rows={3} /></div>
            <div className="form-group"><label>Branch</label><input className="form-control" value={branch} onChange={e => setBranch(e.target.value)} placeholder="main" /></div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={loading}>{loading ? 'Saving...' : 'Save Version'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
