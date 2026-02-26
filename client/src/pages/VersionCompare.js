import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import api from '../services/api';

export default function VersionCompare() {
  const { id } = useParams();
  const [contract, setContract] = useState(null);
  const [v1, setV1] = useState('');
  const [v2, setV2] = useState('');
  const [comparison, setComparison] = useState(null);
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState('sections');

  useEffect(() => {
    api.getContract(id).then(data => {
      setContract(data);
      if (data.versions?.length >= 2) {
        setV1(String(data.versions[data.versions.length - 1].id));
        setV2(String(data.versions[0].id));
      }
    }).catch(console.error);
  }, [id]);

  useEffect(() => {
    if (v1 && v2 && v1 !== v2) {
      setLoading(true);
      api.compareVersions(id, v1, v2).then(data => {
        setComparison(data);
        setLoading(false);
      }).catch(err => { console.error(err); setLoading(false); });
    }
  }, [id, v1, v2]);

  if (!contract) return <div className="flex-center" style={{ padding: 60 }}>Loading...</div>;

  return (
    <div>
      <div className="mb-4">
        <Link to={`/contracts/${id}`} className="text-sm text-muted">&larr; Back to {contract.title}</Link>
        <h1 style={{ fontSize: 24, fontWeight: 700, marginTop: 4 }}>Version Comparison</h1>
      </div>

      <div className="card mb-4">
        <div className="card-body">
          <div className="flex gap-3" style={{ alignItems: 'flex-end' }}>
            <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
              <label>Base Version (Left)</label>
              <select className="form-control" value={v1} onChange={e => setV1(e.target.value)}>
                <option value="">Select version...</option>
                {(contract.versions || []).map(v => (
                  <option key={v.id} value={v.id}>v{v.version_number} - {v.version_label} ({new Date(v.created_at).toLocaleDateString()})</option>
                ))}
              </select>
            </div>
            <div style={{ padding: '8px 0', fontWeight: 700, color: 'var(--gray-400)' }}>vs</div>
            <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
              <label>Compared Version (Right)</label>
              <select className="form-control" value={v2} onChange={e => setV2(e.target.value)}>
                <option value="">Select version...</option>
                {(contract.versions || []).map(v => (
                  <option key={v.id} value={v.id}>v{v.version_number} - {v.version_label} ({new Date(v.created_at).toLocaleDateString()})</option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </div>

      {loading && <div className="flex-center" style={{ padding: 40 }}>Comparing versions...</div>}

      {comparison && !loading && (
        <div>
          <div className="flex-between mb-3">
            <div className="flex gap-2 text-sm">
              <span style={{ background: '#dcfce7', padding: '2px 8px', borderRadius: 4 }}>Added</span>
              <span style={{ background: '#fee2e2', padding: '2px 8px', borderRadius: 4, textDecoration: 'line-through' }}>Removed</span>
            </div>
            <div className="flex gap-2">
              <button className={`btn btn-sm ${viewMode === 'sections' ? 'btn-primary' : 'btn-outline'}`} onClick={() => setViewMode('sections')}>By Section</button>
              <button className={`btn btn-sm ${viewMode === 'full' ? 'btn-primary' : 'btn-outline'}`} onClick={() => setViewMode('full')}>Full Text</button>
            </div>
          </div>

          {viewMode === 'sections' ? (
            comparison.sectionDiffs.map((sd, i) => {
              const hasChanges = sd.original !== sd.modified;
              return (
                <div key={i} className="card mb-3">
                  <div className="card-header">
                    <h3>{sd.section_number}. {sd.title}</h3>
                    {hasChanges ? (
                      <span className="status-badge status-under_review">Modified</span>
                    ) : (
                      <span className="status-badge status-draft">Unchanged</span>
                    )}
                  </div>
                  {hasChanges && (
                    <div className="diff-container" style={{ border: 'none' }}>
                      <div className="diff-side">
                        <div className="diff-side-header" style={{ background: '#fee2e2', color: '#991b1b' }}>
                          v{comparison.version1.version_number} - {comparison.version1.version_label}
                        </div>
                        <div className="diff-side-content">{sd.original}</div>
                      </div>
                      <div className="diff-side">
                        <div className="diff-side-header" style={{ background: '#dcfce7', color: '#166534' }}>
                          v{comparison.version2.version_number} - {comparison.version2.version_label}
                        </div>
                        <div className="diff-side-content">{sd.modified}</div>
                      </div>
                    </div>
                  )}
                  {hasChanges && (
                    <div className="card-body" style={{ borderTop: '1px solid var(--gray-200)' }}>
                      <strong className="text-sm">Inline Changes:</strong>
                      <div className="diff-inline" style={{ marginTop: 8, lineHeight: 1.8 }}>
                        {sd.diff.map((part, j) => (
                          <span key={j} className={part.added ? 'diff-added' : part.removed ? 'diff-removed' : ''}>
                            {part.value}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          ) : (
            <div className="card">
              <div className="card-body diff-inline" style={{ lineHeight: 1.8, fontSize: 14 }}>
                {comparison.diff.map((part, i) => (
                  <span key={i} className={part.added ? 'diff-added' : part.removed ? 'diff-removed' : ''}>
                    {part.value}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Timeline */}
          <div className="card mt-4">
            <div className="card-header"><h3>Version Timeline</h3></div>
            <div className="card-body">
              <div className="timeline">
                {(contract.versions || []).map(v => (
                  <div key={v.id} className="timeline-item">
                    <div className="timeline-date">{new Date(v.created_at).toLocaleString()}</div>
                    <div className="timeline-content">
                      <span className="timeline-actor">v{v.version_number}</span> — {v.version_label}
                      {v.change_summary && <div className="text-sm text-muted">{v.change_summary}</div>}
                      <div className="text-sm text-muted">by {v.created_by_name} {v.branch_name !== 'main' ? `(branch: ${v.branch_name})` : ''}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
