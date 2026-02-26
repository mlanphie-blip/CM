import React, { useState, useEffect, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import api from '../services/api';

export default function ContractDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [contract, setContract] = useState(null);
  const [activeTab, setActiveTab] = useState('sections');
  const [showProposalForm, setShowProposalForm] = useState(false);
  const [selectedSection, setSelectedSection] = useState(null);
  const [editing, setEditing] = useState(false);
  const [editSections, setEditSections] = useState([]);
  const [proposals, setProposals] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [showVersionForm, setShowVersionForm] = useState(false);
  const [error, setError] = useState('');

  const loadContract = useCallback(async () => {
    try {
      const data = await api.getContract(id);
      setContract(data);
      setEditSections(data.sections.map(s => ({ ...s })));
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

  const handleSaveSections = async () => {
    try {
      await api.updateSections(id, editSections);
      setEditing(false);
      loadContract();
    } catch (err) { setError(err.message); }
  };

  const handleDelete = async () => {
    if (!window.confirm('Delete this contract and all related data?')) return;
    try { await api.deleteContract(id); navigate('/contracts'); } catch (err) { setError(err.message); }
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

  if (error && !contract) return <div className="card"><div className="card-body"><p style={{ color: 'var(--danger)' }}>{error}</p></div></div>;
  if (!contract) return <div className="flex-center" style={{ padding: 60 }}>Loading...</div>;

  const canEdit = user?.role === 'admin' || user?.role === 'editor';

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
          <div style={{ position: 'relative', display: 'inline-block' }}>
            <ExportMenu onExport={handleExport} />
          </div>
          {user?.role === 'admin' && <button className="btn btn-danger btn-sm" onClick={handleDelete}>Delete</button>}
        </div>
      </div>

      {error && <div className="login-error mb-4">{error}</div>}

      <div className="tabs">
        <button className={`tab ${activeTab === 'sections' ? 'active' : ''}`} onClick={() => setActiveTab('sections')}>Sections</button>
        <button className={`tab ${activeTab === 'proposals' ? 'active' : ''}`} onClick={() => setActiveTab('proposals')}>
          Proposals ({proposals.length})
        </button>
        <button className={`tab ${activeTab === 'versions' ? 'active' : ''}`} onClick={() => setActiveTab('versions')}>
          Versions ({contract.versions?.length || 0})
        </button>
      </div>

      {activeTab === 'sections' && (
        <div>
          {canEdit && !editing && (
            <div className="flex gap-2 mb-3">
              <button className="btn btn-outline btn-sm" onClick={() => setEditing(true)}>Edit Sections</button>
            </div>
          )}
          {editing ? (
            <div className="card">
              <div className="card-body">
                {editSections.map((s, i) => (
                  <div key={i} style={{ border: '1px solid var(--gray-200)', borderRadius: 'var(--radius)', padding: 16, marginBottom: 12 }}>
                    <div className="flex gap-2 mb-3">
                      <input className="form-control" value={s.section_number} onChange={e => { const ns = [...editSections]; ns[i].section_number = e.target.value; setEditSections(ns); }} style={{ maxWidth: 100 }} placeholder="#" />
                      <input className="form-control" value={s.title || ''} onChange={e => { const ns = [...editSections]; ns[i].title = e.target.value; setEditSections(ns); }} placeholder="Title" />
                      <button className="btn btn-ghost btn-sm" onClick={() => setEditSections(editSections.filter((_, idx) => idx !== i))}>&#x2715;</button>
                    </div>
                    <textarea className="form-control" value={s.content} onChange={e => { const ns = [...editSections]; ns[i].content = e.target.value; setEditSections(ns); }} rows={4} />
                  </div>
                ))}
                <div className="flex gap-2">
                  <button className="btn btn-outline btn-sm" onClick={() => setEditSections([...editSections, { section_number: String(editSections.length + 1), title: '', content: '' }])}>+ Add Section</button>
                </div>
              </div>
              <div className="card-footer">
                <button className="btn btn-outline" onClick={() => { setEditing(false); setEditSections(contract.sections.map(s => ({ ...s }))); }}>Cancel</button>
                <button className="btn btn-primary" onClick={handleSaveSections}>Save Changes</button>
              </div>
            </div>
          ) : (
            <div>
              {contract.sections.map(s => (
                <div key={s.id} className="card mb-3" id={`section-${s.id}`}>
                  <div className="card-header">
                    <h3>{s.section_number}. {s.title || 'Untitled Section'}</h3>
                    {canEdit && (
                      <button className="btn btn-primary btn-sm" onClick={() => { setSelectedSection(s); setShowProposalForm(true); }}>
                        Propose Change
                      </button>
                    )}
                  </div>
                  <div className="card-body">
                    <p style={{ whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>{s.content}</p>
                    {proposals.filter(p => p.section_id === s.id).length > 0 && (
                      <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--gray-200)' }}>
                        <strong className="text-sm">Active Proposals:</strong>
                        {proposals.filter(p => p.section_id === s.id).map(p => (
                          <div key={p.id} className="flex-between" style={{ padding: '6px 0' }}>
                            <Link to={`/proposals/${p.id}`} className="text-sm">{p.title}</Link>
                            <span className={`status-badge status-${p.status}`}>{p.status.replace('_', ' ')}</span>
                          </div>
                        ))}
                      </div>
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
          {canEdit && <button className="btn btn-primary btn-sm mb-3" onClick={() => { setSelectedSection(null); setShowProposalForm(true); }}>+ New Proposal</button>}
          {proposals.length === 0 ? (
            <div className="card"><div className="card-body empty-state"><h3>No proposals yet</h3></div></div>
          ) : (
            <div className="card">
              <div className="table-container">
                <table>
                  <thead><tr><th>Title</th><th>Section</th><th>Status</th><th>Proposer</th><th>Feedback</th><th>Date</th></tr></thead>
                  <tbody>
                    {proposals.map(p => (
                      <tr key={p.id}>
                        <td><Link to={`/proposals/${p.id}`} style={{ fontWeight: 600 }}>{p.title}</Link></td>
                        <td className="text-sm">{p.section_number ? `${p.section_number}. ${p.section_title || ''}` : 'N/A'}</td>
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
          section={selectedSection}
          sections={contract.sections}
          templates={templates}
          onClose={() => { setShowProposalForm(false); setSelectedSection(null); }}
          onCreated={() => { setShowProposalForm(false); setSelectedSection(null); loadProposals(); }}
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

function ProposalFormModal({ contractId, section, sections, templates, onClose, onCreated }) {
  const [title, setTitle] = useState('');
  const [sectionId, setSectionId] = useState(section?.id || '');
  const [originalText, setOriginalText] = useState(section?.content || '');
  const [proposedText, setProposedText] = useState(section?.content || '');
  const [rationale, setRationale] = useState('');
  const [priority, setPriority] = useState('medium');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSectionChange = (secId) => {
    setSectionId(secId);
    const sec = sections.find(s => String(s.id) === String(secId));
    if (sec) {
      setOriginalText(sec.content);
      setProposedText(sec.content);
    }
  };

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
      await api.createProposal({ contract_id: contractId, section_id: sectionId || null, title, original_text: originalText, proposed_text: proposedText, rationale, priority });
      onCreated();
    } catch (err) { setError(err.message); }
    setLoading(false);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 900 }}>
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
                <input className="form-control" value={title} onChange={e => setTitle(e.target.value)} required placeholder="Amendment title" />
              </div>
              <div className="form-group" style={{ flex: 1 }}>
                <label>Priority</label>
                <select className="form-control" value={priority} onChange={e => setPriority(e.target.value)}>
                  <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option>
                </select>
              </div>
            </div>
            <div className="form-group">
              <label>Section</label>
              <select className="form-control" value={sectionId} onChange={e => handleSectionChange(e.target.value)}>
                <option value="">-- Select Section --</option>
                {sections.map(s => <option key={s.id} value={s.id}>{s.section_number}. {s.title || 'Untitled'}</option>)}
              </select>
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
                <div className="diff-side-header">Original Text</div>
                <div style={{ padding: 8 }}><textarea className="form-control" value={originalText} onChange={e => setOriginalText(e.target.value)} rows={8} placeholder="Original contract text" /></div>
              </div>
              <div className="diff-side">
                <div className="diff-side-header">Proposed Text</div>
                <div style={{ padding: 8 }}><textarea className="form-control" value={proposedText} onChange={e => setProposedText(e.target.value)} rows={8} placeholder="Your proposed changes" /></div>
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
