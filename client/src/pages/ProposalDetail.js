import React, { useState, useEffect, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import api from '../services/api';
import * as Diff from 'diff';

export default function ProposalDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [proposal, setProposal] = useState(null);
  const [users, setUsers] = useState([]);
  const [commentText, setCommentText] = useState('');
  const [replyTo, setReplyTo] = useState(null);
  const [decisionComment, setDecisionComment] = useState('');
  const [showAssign, setShowAssign] = useState(false);
  const [assignUserId, setAssignUserId] = useState('');
  const [assignRequired, setAssignRequired] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editData, setEditData] = useState({});

  const loadProposal = useCallback(async () => {
    try { setProposal(await api.getProposal(id)); } catch (err) { console.error(err); }
  }, [id]);

  useEffect(() => {
    loadProposal();
    api.getUsers().then(setUsers).catch(() => {});
  }, [loadProposal]);

  if (!proposal) return <div className="flex-center" style={{ padding: 60 }}>Loading...</div>;

  const diff = Diff.diffWords(proposal.original_text || '', proposal.proposed_text || '');
  const canEdit = proposal.proposer_id === user?.id || user?.role === 'admin';
  const canReview = user?.role !== 'reviewer' || proposal.approvals?.some(a => a.reviewer_id === user?.id);

  const handleComment = async (e) => {
    e.preventDefault();
    if (!commentText.trim()) return;
    try {
      await api.addFeedback({ proposal_id: Number(id), comment_text: commentText, parent_feedback_id: replyTo || undefined });
      setCommentText('');
      setReplyTo(null);
      loadProposal();
    } catch (err) { alert(err.message); }
  };

  const handleStatusChange = async (status) => {
    try { await api.updateProposal(id, { status }); loadProposal(); } catch (err) { alert(err.message); }
  };

  const handleSubmitForReview = async () => {
    try { await api.submitProposal(id); loadProposal(); } catch (err) { alert(err.message); }
  };

  const handleApplyChange = async () => {
    try { await api.applyProposal(id); alert('Changes applied to contract'); loadProposal(); } catch (err) { alert(err.message); }
  };

  const handleDecision = async (decision) => {
    try { await api.submitDecision(id, { decision, comments: decisionComment }); setDecisionComment(''); loadProposal(); } catch (err) { alert(err.message); }
  };

  const handleAssignReviewer = async () => {
    if (!assignUserId) return;
    try { await api.assignReviewer({ proposal_id: Number(id), reviewer_id: Number(assignUserId), required: assignRequired }); setShowAssign(false); setAssignUserId(''); loadProposal(); } catch (err) { alert(err.message); }
  };

  const handleSaveEdit = async () => {
    try { await api.updateProposal(id, editData); setEditing(false); loadProposal(); } catch (err) { alert(err.message); }
  };

  const handleDelete = async () => {
    if (!window.confirm('Delete this proposal?')) return;
    try { await api.deleteProposal(id); navigate('/proposals'); } catch (err) { alert(err.message); }
  };

  const handleFeedbackStatus = async (feedbackId, status) => {
    try { await api.updateFeedback(feedbackId, { status }); loadProposal(); } catch (err) { alert(err.message); }
  };

  const rootFeedback = (proposal.feedback || []).filter(f => !f.parent_feedback_id);
  const getReplies = (parentId) => (proposal.feedback || []).filter(f => f.parent_feedback_id === parentId);

  return (
    <div>
      <div className="flex-between mb-4">
        <div>
          <Link to="/proposals" className="text-sm text-muted">&larr; Back to Proposals</Link>
          <h1 style={{ fontSize: 24, fontWeight: 700, marginTop: 4 }}>
            {editing ? <input className="form-control" value={editData.title || proposal.title} onChange={e => setEditData({ ...editData, title: e.target.value })} /> : proposal.title}
          </h1>
          <div className="flex gap-2 mt-2" style={{ alignItems: 'center' }}>
            <span className={`status-badge status-${proposal.status}`}>{proposal.status.replace('_', ' ')}</span>
            <span className={`priority-${proposal.priority} text-sm`} style={{ fontWeight: 600 }}>Priority: {proposal.priority}</span>
            <span className="text-sm text-muted">by {proposal.proposer_name} on {new Date(proposal.created_at).toLocaleDateString()}</span>
          </div>
        </div>
        <div className="flex gap-2">
          {canEdit && proposal.status === 'draft' && (
            <>
              <button className="btn btn-primary btn-sm" onClick={handleSubmitForReview}>Submit for Review</button>
              {!editing && <button className="btn btn-outline btn-sm" onClick={() => { setEditing(true); setEditData({ title: proposal.title, proposed_text: proposal.proposed_text, rationale: proposal.rationale, priority: proposal.priority }); }}>Edit</button>}
              {editing && <button className="btn btn-success btn-sm" onClick={handleSaveEdit}>Save</button>}
              {editing && <button className="btn btn-outline btn-sm" onClick={() => setEditing(false)}>Cancel</button>}
            </>
          )}
          {canEdit && proposal.status === 'approved' && <button className="btn btn-success btn-sm" onClick={handleApplyChange}>Apply to Contract</button>}
          {canEdit && <button className="btn btn-danger btn-sm" onClick={handleDelete}>Delete</button>}
        </div>
      </div>

      {/* Conflict warnings */}
      {proposal.conflicts?.length > 0 && (
        <div style={{ background: 'var(--warning-light)', padding: '12px 16px', borderRadius: 'var(--radius)', marginBottom: 16 }}>
          <strong style={{ color: 'var(--warning)' }}>Conflict Warning:</strong>
          <span className="text-sm"> Other proposals also affect this section: </span>
          {proposal.conflicts.map(c => <Link key={c.id} to={`/proposals/${c.id}`} className="text-sm" style={{ marginRight: 8 }}>{c.title} ({c.status})</Link>)}
        </div>
      )}

      <div className="grid" style={{ gridTemplateColumns: '1fr 360px', gap: 20 }}>
        {/* Main content */}
        <div>
          {/* Diff view */}
          <div className="card mb-4">
            <div className="card-header"><h3>Proposed Changes</h3></div>
            <div className="diff-container" style={{ border: 'none' }}>
              <div className="diff-side">
                <div className="diff-side-header" style={{ background: '#fee2e2', color: '#991b1b' }}>Original Text</div>
                <div className="diff-side-content">{proposal.original_text}</div>
              </div>
              <div className="diff-side">
                <div className="diff-side-header" style={{ background: '#dcfce7', color: '#166534' }}>Proposed Text</div>
                <div className="diff-side-content">
                  {editing ? (
                    <textarea className="form-control" value={editData.proposed_text || ''} onChange={e => setEditData({ ...editData, proposed_text: e.target.value })} rows={8} style={{ minHeight: '100%' }} />
                  ) : proposal.proposed_text}
                </div>
              </div>
            </div>
          </div>

          {/* Inline diff */}
          <div className="card mb-4">
            <div className="card-header"><h3>Inline Diff</h3></div>
            <div className="card-body diff-inline" style={{ lineHeight: 1.8 }}>
              {diff.map((part, i) => (
                <span key={i} className={part.added ? 'diff-added' : part.removed ? 'diff-removed' : ''}>
                  {part.value}
                </span>
              ))}
            </div>
          </div>

          {/* Rationale */}
          <div className="card mb-4">
            <div className="card-header"><h3>Rationale</h3></div>
            <div className="card-body">
              {editing ? (
                <textarea className="form-control" value={editData.rationale || ''} onChange={e => setEditData({ ...editData, rationale: e.target.value })} rows={4} />
              ) : (
                <p style={{ whiteSpace: 'pre-wrap' }}>{proposal.rationale || 'No rationale provided'}</p>
              )}
            </div>
          </div>

          {/* Feedback section */}
          <div className="card">
            <div className="card-header"><h3>Discussion ({proposal.feedback?.length || 0})</h3></div>
            <div className="card-body">
              {rootFeedback.length === 0 && <p className="text-muted text-sm">No comments yet. Be the first to provide feedback.</p>}
              {rootFeedback.map(f => (
                <FeedbackItem key={f.id} feedback={f} replies={getReplies(f.id)} user={user}
                  onReply={() => setReplyTo(f.id)} onStatusChange={handleFeedbackStatus} getReplies={getReplies} setReplyTo={setReplyTo} />
              ))}
              <form onSubmit={handleComment} style={{ marginTop: 16 }}>
                {replyTo && (
                  <div className="text-sm mb-3" style={{ color: 'var(--primary)' }}>
                    Replying to comment #{replyTo} <button type="button" className="btn-ghost btn-sm" onClick={() => setReplyTo(null)}>Cancel</button>
                  </div>
                )}
                <textarea className="form-control" value={commentText} onChange={e => setCommentText(e.target.value)} placeholder="Add your feedback..." rows={3} />
                <button type="submit" className="btn btn-primary btn-sm mt-2" disabled={!commentText.trim()}>Post Comment</button>
              </form>
            </div>
          </div>
        </div>

        {/* Sidebar */}
        <div>
          {/* Info card */}
          <div className="card mb-4">
            <div className="card-header"><h3>Details</h3></div>
            <div className="card-body">
              <div className="text-sm" style={{ display: 'grid', gap: 10 }}>
                <div><strong>Contract:</strong> <Link to={`/contracts/${proposal.contract_id}`}>{proposal.contract_title}</Link></div>
                {proposal.section_number && <div><strong>Section:</strong> {proposal.section_number}. {proposal.section_title}</div>}
                <div><strong>Proposer:</strong> {proposal.proposer_name} ({proposal.proposer_role})</div>
                <div><strong>Created:</strong> {new Date(proposal.created_at).toLocaleString()}</div>
                <div><strong>Updated:</strong> {new Date(proposal.updated_at).toLocaleString()}</div>
              </div>
            </div>
          </div>

          {/* Approval status */}
          <div className="card mb-4">
            <div className="card-header">
              <h3>Approvals</h3>
              {(user?.role === 'admin' || user?.role === 'editor') && (
                <button className="btn btn-ghost btn-sm" onClick={() => setShowAssign(!showAssign)}>+ Assign</button>
              )}
            </div>
            <div className="card-body">
              {showAssign && (
                <div style={{ marginBottom: 16, padding: 12, background: 'var(--gray-50)', borderRadius: 'var(--radius)' }}>
                  <select className="form-control mb-3" value={assignUserId} onChange={e => setAssignUserId(e.target.value)}>
                    <option value="">Select reviewer...</option>
                    {users.filter(u => !(proposal.approvals || []).some(a => a.reviewer_id === u.id)).map(u => (
                      <option key={u.id} value={u.id}>{u.full_name} ({u.role})</option>
                    ))}
                  </select>
                  <label className="text-sm" style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 }}>
                    <input type="checkbox" checked={assignRequired} onChange={e => setAssignRequired(e.target.checked)} /> Required reviewer
                  </label>
                  <button className="btn btn-primary btn-sm" onClick={handleAssignReviewer}>Assign</button>
                </div>
              )}
              {(proposal.approvals || []).length === 0 ? (
                <p className="text-sm text-muted">No reviewers assigned</p>
              ) : (
                (proposal.approvals || []).map(a => (
                  <div key={a.id} className="flex-between" style={{ padding: '8px 0', borderBottom: '1px solid var(--gray-100)' }}>
                    <div>
                      <div className="text-sm" style={{ fontWeight: 600 }}>{a.reviewer_name}</div>
                      <div className="text-sm text-muted">{a.reviewer_role}{a.required ? ' (required)' : ''}</div>
                    </div>
                    <span className={`status-badge status-${a.decision}`}>{a.decision}</span>
                  </div>
                ))
              )}

              {/* Review decision */}
              {proposal.status === 'under_review' && (
                <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--gray-200)' }}>
                  <label className="text-sm" style={{ fontWeight: 600, display: 'block', marginBottom: 6 }}>Your Decision</label>
                  <textarea className="form-control mb-3" value={decisionComment} onChange={e => setDecisionComment(e.target.value)} placeholder="Optional comments..." rows={2} />
                  <div className="flex gap-2">
                    <button className="btn btn-success btn-sm" onClick={() => handleDecision('approved')}>Approve</button>
                    <button className="btn btn-danger btn-sm" onClick={() => handleDecision('rejected')}>Reject</button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Actions */}
          {canEdit && (
            <div className="card">
              <div className="card-header"><h3>Actions</h3></div>
              <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {proposal.status === 'draft' && <button className="btn btn-primary btn-sm w-full" onClick={handleSubmitForReview}>Submit for Review</button>}
                {proposal.status === 'under_review' && canEdit && <button className="btn btn-warning btn-sm w-full" onClick={() => handleStatusChange('draft')}>Return to Draft</button>}
                {proposal.status === 'approved' && <button className="btn btn-success btn-sm w-full" onClick={handleApplyChange}>Apply Changes</button>}
                {proposal.status !== 'withdrawn' && canEdit && <button className="btn btn-outline btn-sm w-full" onClick={() => handleStatusChange('withdrawn')}>Withdraw</button>}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FeedbackItem({ feedback, replies, user, onReply, onStatusChange, getReplies, setReplyTo }) {
  return (
    <div className={`comment ${feedback.parent_feedback_id ? 'reply' : ''}`}>
      <div className="comment-header">
        <div>
          <span className="comment-author">{feedback.commenter_name}</span>
          <span className="comment-role">{feedback.commenter_role}</span>
        </div>
        <div className="flex gap-2" style={{ alignItems: 'center' }}>
          <span className={`status-badge status-${feedback.status}`}>{feedback.status}</span>
          <span className="comment-date">{new Date(feedback.created_at).toLocaleString()}</span>
        </div>
      </div>
      <div className="comment-body">{feedback.comment_text}</div>
      <div className="comment-actions">
        <button className="btn btn-ghost btn-sm" onClick={onReply}>Reply</button>
        {feedback.status === 'open' && (
          <>
            <button className="btn btn-ghost btn-sm" onClick={() => onStatusChange(feedback.id, 'addressed')}>Mark Addressed</button>
            <button className="btn btn-ghost btn-sm" onClick={() => onStatusChange(feedback.id, 'resolved')}>Mark Resolved</button>
          </>
        )}
      </div>
      {replies.map(r => (
        <FeedbackItem key={r.id} feedback={r} replies={getReplies(r.id)} user={user}
          onReply={() => setReplyTo(r.id)} onStatusChange={onStatusChange} getReplies={getReplies} setReplyTo={setReplyTo} />
      ))}
    </div>
  );
}
