import React, { useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import api from '../services/api';

export default function Navbar() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    loadNotifications();
    const interval = setInterval(loadNotifications, 30000);
    return () => clearInterval(interval);
  }, []);

  const loadNotifications = async () => {
    try {
      const data = await api.getNotifications(true);
      setUnreadCount(data.length);
    } catch {}
  };

  const isActive = (path) => location.pathname === path || location.pathname.startsWith(path + '/');

  return (
    <nav className="navbar">
      <Link to="/" className="navbar-brand" style={{ textDecoration: 'none' }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
          <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
        </svg>
        ContractAmend
      </Link>
      <div className="navbar-nav">
        <Link to="/" className={isActive('/') && location.pathname === '/' ? 'active' : ''}>Dashboard</Link>
        <Link to="/contracts" className={isActive('/contracts') ? 'active' : ''}>Contracts</Link>
        <Link to="/proposals" className={isActive('/proposals') ? 'active' : ''}>Proposals</Link>
        <Link to="/approvals" className={isActive('/approvals') ? 'active' : ''}>Approvals</Link>
        <Link to="/activity" className={isActive('/activity') ? 'active' : ''}>Activity</Link>
      </div>
      <div className="navbar-right">
        <Link to="/activity" className="notification-btn btn-ghost" title="Notifications">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0" />
          </svg>
          {unreadCount > 0 && <span className="badge badge-danger">{unreadCount}</span>}
        </Link>
        <span className="user-info">
          <strong>{user?.full_name}</strong> <span className="text-sm">({user?.role})</span>
        </span>
        <button className="btn btn-outline btn-sm" onClick={logout}>Logout</button>
      </div>
    </nav>
  );
}
