const BASE_URL = '/api';

function getToken() {
  return localStorage.getItem('token');
}

async function request(path, options = {}) {
  const token = getToken();
  const headers = { ...options.headers };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (!(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers });

  if (res.status === 401) {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = '/login';
    throw new Error('Unauthorized');
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(data.error || 'Request failed');
  }

  const contentType = res.headers.get('Content-Type') || '';
  if (contentType.includes('application/json')) {
    return res.json();
  }
  return res;
}

const api = {
  // Auth
  login: (username, password) => request('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  register: (data) => request('/auth/register', { method: 'POST', body: JSON.stringify(data) }),
  getMe: () => request('/auth/me'),
  getUsers: () => request('/auth/users'),

  // Contracts
  getContracts: () => request('/contracts'),
  getContract: (id) => request(`/contracts/${id}`),
  createContract: (formData) => request('/contracts', { method: 'POST', body: formData }),
  updateSections: (id, sections) => request(`/contracts/${id}/sections`, { method: 'PUT', body: JSON.stringify({ sections }) }),
  createVersion: (id, data) => request(`/contracts/${id}/versions`, { method: 'POST', body: JSON.stringify(data) }),
  getVersion: (contractId, versionId) => request(`/contracts/${contractId}/versions/${versionId}`),
  compareVersions: (contractId, v1, v2) => request(`/contracts/${contractId}/compare?v1=${v1}&v2=${v2}`),
  rollback: (contractId, versionId) => request(`/contracts/${contractId}/rollback/${versionId}`, { method: 'POST' }),
  deleteContract: (id) => request(`/contracts/${id}`, { method: 'DELETE' }),
  reparseContract: (id) => request(`/contracts/${id}/reparse`, { method: 'POST' }),

  // Proposals
  getProposals: (params = {}) => {
    const query = new URLSearchParams(params).toString();
    return request(`/proposals${query ? '?' + query : ''}`);
  },
  getProposal: (id) => request(`/proposals/${id}`),
  createProposal: (data) => request('/proposals', { method: 'POST', body: JSON.stringify(data) }),
  updateProposal: (id, data) => request(`/proposals/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  submitProposal: (id, data) => request(`/proposals/${id}/submit`, { method: 'POST', body: JSON.stringify(data || {}) }),
  applyProposal: (id) => request(`/proposals/${id}/apply`, { method: 'POST' }),
  deleteProposal: (id) => request(`/proposals/${id}`, { method: 'DELETE' }),
  getBundles: (contractId) => request(`/proposals/bundles/list${contractId ? '?contract_id=' + contractId : ''}`),
  createBundle: (data) => request('/proposals/bundles', { method: 'POST', body: JSON.stringify(data) }),
  getTemplates: () => request('/proposals/templates/list'),

  // Feedback
  addFeedback: (data) => request('/feedback', { method: 'POST', body: JSON.stringify(data) }),
  updateFeedback: (id, data) => request(`/feedback/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteFeedback: (id) => request(`/feedback/${id}`, { method: 'DELETE' }),

  // Approvals
  getDashboard: () => request('/approvals/dashboard'),
  assignReviewer: (data) => request('/approvals', { method: 'POST', body: JSON.stringify(data) }),
  submitDecision: (proposalId, data) => request(`/approvals/${proposalId}/decide`, { method: 'PUT', body: JSON.stringify(data) }),

  // Notifications
  getNotifications: (unread) => request(`/notifications${unread ? '?unread=true' : ''}`),
  markNotificationRead: (id) => request(`/notifications/${id}/read`, { method: 'PUT' }),
  markAllRead: () => request('/notifications/read-all', { method: 'PUT' }),
  getActivity: (limit = 50) => request(`/notifications/activity?limit=${limit}`),

  // Export
  getRedlineUrl: (contractId) => `${BASE_URL}/export/redline/${contractId}`,
  getCleanUrl: (contractId) => `${BASE_URL}/export/clean/${contractId}`,
  getDocxUrl: (contractId, type) => `${BASE_URL}/export/docx/${contractId}?type=${type || 'clean'}`,
};

export default api;
