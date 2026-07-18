# Research Project Management - Backend

This is the backend service for the Research Project Management application. It is built with Node.js, Express, and MongoDB.

## Tech Stack

- **Runtime**: Node.js
- **Framework**: Express.js
- **Database**: MongoDB (via Mongoose)
- **Caching & Sessions**: Redis
- **Authentication**: Passport.js (Local, Google, GitHub OAuth)
- **Storage**: AWS S3
- **Real-time**: Socket.io
- **Validation**: Zod & express-validator
- **Dependency Injection**: Awilix
- **Testing**: Jest, Supertest, MongoDB Memory Server
- **Package Manager**: pnpm

## Prerequisites

- Node.js (v18 or higher recommended)
- MongoDB
- Redis
- pnpm (`npm install -g pnpm`)

## Environment Variables

Copy `.env.example` to `.env` and fill in the required environment variables:

```bash
cp .env.example .env
```

## Installation

Install dependencies using pnpm:

```bash
pnpm install
```

## Running the Application

**Development Mode:**
Runs the server with Nodemon for hot-reloading.
```bash
pnpm run dev
```

**Production Mode:**
```bash
pnpm start
```

## Testing

Run the test suite using Jest:
```bash
pnpm test
```

## Docker

A `Dockerfile` and `docker-compose.yml` are provided for containerized environments.
