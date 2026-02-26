import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import Navbar from './components/Navbar';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import ContractList from './pages/ContractList';
import ContractDetail from './pages/ContractDetail';
import ProposalList from './pages/ProposalList';
import ProposalDetail from './pages/ProposalDetail';
import VersionCompare from './pages/VersionCompare';
import ApprovalDashboard from './pages/ApprovalDashboard';
import ActivityFeed from './pages/ActivityFeed';

function PrivateRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="flex-center" style={{ height: '100vh' }}>Loading...</div>;
  return user ? children : <Navigate to="/login" />;
}

function AppRoutes() {
  const { user } = useAuth();
  return (
    <BrowserRouter>
      {user && <Navbar />}
      <div className={user ? 'main-content' : ''}>
        <Routes>
          <Route path="/login" element={user ? <Navigate to="/" /> : <Login />} />
          <Route path="/" element={<PrivateRoute><Dashboard /></PrivateRoute>} />
          <Route path="/contracts" element={<PrivateRoute><ContractList /></PrivateRoute>} />
          <Route path="/contracts/:id" element={<PrivateRoute><ContractDetail /></PrivateRoute>} />
          <Route path="/contracts/:id/compare" element={<PrivateRoute><VersionCompare /></PrivateRoute>} />
          <Route path="/proposals" element={<PrivateRoute><ProposalList /></PrivateRoute>} />
          <Route path="/proposals/:id" element={<PrivateRoute><ProposalDetail /></PrivateRoute>} />
          <Route path="/approvals" element={<PrivateRoute><ApprovalDashboard /></PrivateRoute>} />
          <Route path="/activity" element={<PrivateRoute><ActivityFeed /></PrivateRoute>} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}
