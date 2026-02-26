import React, { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import api from '../services/api';

export default function ActivityFeed() {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState('notifications');
  const [notifications, setNotifications] = useState([]);
  const [activity, setActivity] = useState([]);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const [notifs, acts] = await Promise.all([
        api.getNotifications(),
        api.getActivity(100)
      ]);
      setNotifications(notifs);
      setActivity(acts);
    } catch (err) { console.error(err); }
  };

  const handleMarkRead = async (id) => {
    try { await api.markNotificationRead(id); loadData(); } catch {}
  };

  const handleMarkAllRead = async () => {
    try { await api.markAllRead(); loadData(); } catch {}
  };

  const formatDate = (d) => {
    if (!d) return '';
    const date = new Date(d + (d.includes('T') ? '' : 'T00:00:00'));
    return date.toLocaleString();
  };

  const formatAction = (action) => {
    const map = {
      create_contract: 'Created contract',
      update_sections: 'Updated sections',
      create_version: 'Created version',
      create_proposal: 'Created proposal',
      update_proposal: 'Updated proposal',
      submit_proposal: 'Submitted proposal',
      apply_proposal: 'Applied proposal',
      delete_proposal: 'Deleted proposal',
      add_feedback: 'Added comment',
      update_feedback: 'Updated comment',
      approval_decision: 'Made review decision',
      assign_reviewer: 'Assigned reviewer',
      rollback: 'Rolled back version',
      export_redline: 'Exported redline',
      export_clean: 'Exported clean version',
      export_docx: 'Exported DOCX',
      login: 'Logged in',
      register: 'Registered',
    };
    return map[action] || action.replace(/_/g, ' ');
  };

  const unreadCount = notifications.filter(n => !n.read).length;

  return (
    <div>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 20 }}>Activity & Notifications</h1>

      <div className="tabs">
        <button className={`tab ${activeTab === 'notifications' ? 'active' : ''}`} onClick={() => setActiveTab('notifications')}>
          Notifications {unreadCount > 0 && <span className="badge badge-danger" style={{ marginLeft: 6 }}>{unreadCount}</span>}
        </button>
        <button className={`tab ${activeTab === 'activity' ? 'active' : ''}`} onClick={() => setActiveTab('activity')}>
          Audit Log
        </button>
      </div>

      {activeTab === 'notifications' && (
        <div>
          {unreadCount > 0 && (
            <div className="mb-3">
              <button className="btn btn-outline btn-sm" onClick={handleMarkAllRead}>Mark All as Read</button>
            </div>
          )}
          {notifications.length === 0 ? (
            <div className="card"><div className="card-body empty-state"><h3>No notifications</h3></div></div>
          ) : (
            <div className="card">
              {notifications.map(n => (
                <div key={n.id} style={{
                  padding: '14px 20px', borderBottom: '1px solid var(--gray-100)',
                  background: n.read ? 'white' : 'var(--primary-light)',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center'
                }}>
                  <div>
                    <div style={{ fontWeight: n.read ? 400 : 600, fontSize: 14 }}>{n.title}</div>
                    {n.message && <div className="text-sm text-muted">{n.message}</div>}
                    <div className="text-sm text-muted">{formatDate(n.created_at)}</div>
                  </div>
                  {!n.read && <button className="btn btn-ghost btn-sm" onClick={() => handleMarkRead(n.id)}>Mark Read</button>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'activity' && (
        <div className="card">
          {activity.length === 0 ? (
            <div className="card-body empty-state"><h3>No activity recorded</h3></div>
          ) : (
            <div className="table-container">
              <table>
                <thead><tr><th>Action</th><th>Entity</th><th>User</th><th>Timestamp</th></tr></thead>
                <tbody>
                  {activity.map(a => (
                    <tr key={a.id}>
                      <td className="text-sm">{formatAction(a.action)}</td>
                      <td className="text-sm">{a.entity_type} #{a.entity_id}</td>
                      <td className="text-sm">{a.user_name || 'System'}</td>
                      <td className="text-sm text-muted">{formatDate(a.created_at)}</td>
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
