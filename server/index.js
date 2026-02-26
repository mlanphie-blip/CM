const express = require('express');
const cors = require('cors');
const path = require('path');

// Initialize database
require('./db-init');

const authRoutes = require('./routes/auth');
const contractRoutes = require('./routes/contracts');
const proposalRoutes = require('./routes/proposals');
const feedbackRoutes = require('./routes/feedback');
const approvalRoutes = require('./routes/approvals');
const notificationRoutes = require('./routes/notifications');
const exportRoutes = require('./routes/export');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/contracts', contractRoutes);
app.use('/api/proposals', proposalRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/approvals', approvalRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/export', exportRoutes);

// Serve static files in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '..', 'client', 'build')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'client', 'build', 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`Contract Amendment Manager API running on port ${PORT}`);
});

module.exports = app;
