# Contract Amendment Manager

A full-stack web application for managing contract amendments, proposals, reviews, and version control.

## Features

- **Contract Storage & Display**: Upload PDF/DOCX/TXT contracts, parsed into editable sections
- **Amendment Proposals**: Select any section and propose changes with rationale
- **Feedback & Review Workflow**: Thread-based discussion on proposals with status tracking
- **Multi-Stakeholder Approvals**: Assign required/optional reviewers, track approval status
- **Version Comparison**: Side-by-side diff with additions (green) and deletions (red)
- **Document Generation**: Export redline and clean versions as HTML or DOCX
- **Audit Trail**: Complete log of all actions
- **Notifications**: Real-time notification system for proposals, feedback, and approvals
- **Amendment Bundles**: Group related amendments together
- **Conflict Detection**: Warns when multiple proposals affect the same section
- **Amendment Templates**: Pre-built templates for common changes
- **Branch/Merge**: Version branching for parallel amendment tracks

## Quick Start

### Prerequisites
- Node.js 18+ and npm

### Installation

```bash
# Install all dependencies (server + client)
npm run install:all

# Initialize the database with seed data
npm run db:init

# Start both server and client in development mode
npm run dev
```

The API server runs on **http://localhost:3001** and the React client on **http://localhost:3000**.

### Default User Accounts

| Username   | Password     | Role     |
|------------|-------------|----------|
| admin      | admin123    | Admin    |
| editor     | editor123   | Editor   |
| reviewer   | reviewer123 | Reviewer |

## Architecture

### Backend (Node.js/Express)
- **API Server**: Express.js on port 3001
- **Database**: SQLite via better-sqlite3 (stored in `data/contract_manager.db`)
- **Authentication**: JWT-based with role-based access control
- **File Parsing**: mammoth (DOCX) and pdf-parse (PDF)
- **Export**: docx library for DOCX generation, HTML for redline/clean views

### Frontend (React)
- **Routing**: React Router v6
- **State**: React Context for auth, component-level state elsewhere
- **Styling**: Custom CSS with CSS variables (no external UI framework)
- **Diff Engine**: `diff` library for text comparison

### Database Schema

| Table | Purpose |
|-------|---------|
| users | User accounts with roles |
| contracts | Base contract metadata |
| contract_sections | Individual clauses/sections |
| contract_versions | Version snapshots with full text |
| proposals | Amendment proposals with status |
| feedback | Threaded comments on proposals |
| approvals | Reviewer decisions per proposal |
| amendment_bundles | Groups of related proposals |
| amendment_templates | Reusable amendment templates |
| notifications | User notifications |
| audit_log | Complete action history |
| cross_references | Section cross-reference tracking |

### API Endpoints

#### Auth
- `POST /api/auth/login` - Login
- `POST /api/auth/register` - Register new user
- `GET /api/auth/me` - Get current user
- `GET /api/auth/users` - List all users

#### Contracts
- `GET /api/contracts` - List contracts
- `GET /api/contracts/:id` - Get contract with sections and versions
- `POST /api/contracts` - Create contract (multipart form with file upload)
- `PUT /api/contracts/:id/sections` - Update sections
- `POST /api/contracts/:id/versions` - Save new version
- `GET /api/contracts/:id/compare?v1=X&v2=Y` - Compare two versions
- `POST /api/contracts/:id/rollback/:versionId` - Rollback to version
- `DELETE /api/contracts/:id` - Delete contract

#### Proposals
- `GET /api/proposals` - List proposals (with filters)
- `GET /api/proposals/:id` - Get proposal with feedback and approvals
- `POST /api/proposals` - Create proposal
- `PUT /api/proposals/:id` - Update proposal
- `POST /api/proposals/:id/submit` - Submit for review
- `POST /api/proposals/:id/apply` - Apply approved changes
- `DELETE /api/proposals/:id` - Delete proposal
- `GET /api/proposals/templates/list` - List amendment templates
- `GET /api/proposals/bundles/list` - List amendment bundles
- `POST /api/proposals/bundles` - Create bundle

#### Feedback
- `POST /api/feedback` - Add comment
- `PUT /api/feedback/:id` - Update comment status
- `DELETE /api/feedback/:id` - Delete comment

#### Approvals
- `GET /api/approvals/dashboard` - Approval dashboard
- `POST /api/approvals` - Assign reviewer
- `PUT /api/approvals/:proposalId/decide` - Submit decision

#### Notifications
- `GET /api/notifications` - Get notifications
- `PUT /api/notifications/:id/read` - Mark as read
- `PUT /api/notifications/read-all` - Mark all as read
- `GET /api/notifications/activity` - Get audit activity feed

#### Export
- `GET /api/export/redline/:contractId` - Redline HTML
- `GET /api/export/clean/:contractId` - Clean HTML
- `GET /api/export/docx/:contractId?type=clean|redline` - DOCX export

## User Roles

| Role | Permissions |
|------|------------|
| **Admin** | Full access: create/edit/delete contracts, proposals, manage users, rollback versions |
| **Editor** | Create/edit contracts and proposals, assign reviewers |
| **Reviewer** | View contracts, comment on proposals, submit approval decisions |

## Workflow

1. **Create Contract**: Upload a file or enter sections manually
2. **Propose Amendment**: Select a section, write proposed changes with rationale
3. **Submit for Review**: Move proposal from draft to under review
4. **Assign Reviewers**: Add required/optional reviewers to the proposal
5. **Collect Feedback**: Reviewers comment and discuss in threads
6. **Approval Decision**: Reviewers approve or reject
7. **Apply Changes**: Apply approved amendments to the contract
8. **Save Version**: Snapshot the contract state after changes
9. **Export**: Generate redline or clean documents for distribution

## Production Deployment

```bash
# Build the React client
npm run build

# Start production server (serves API + static client build)
NODE_ENV=production npm start
```

Set the `JWT_SECRET` environment variable to a secure random string in production.
