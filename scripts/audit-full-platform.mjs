import { performance } from 'perf_hooks';

const BASE_URL = 'http://localhost:3000';
const EMAIL = 'ngotanthanh92.26@gmail.com';
const PASSWORD = 'Password123!';

async function runAudit() {
  console.log('\n========================================================================');
  console.log('🚀 FLUX PLATFORM: COMPREHENSIVE AUTHENTICATION & API ROUTE AUDIT');
  console.log(`🌐 Base URL: ${BASE_URL}`);
  console.log(`👤 Target User: ${EMAIL}`);
  console.log('========================================================================\n');

  // 1. Authenticate / Login
  console.log('🔑 Step 1: Performing Authentication (POST /api/auth/login)...');
  const loginStart = performance.now();
  let loginRes;
  try {
    loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
  } catch (err) {
    console.error('❌ Failed to connect to server:', err.message);
    process.exit(1);
  }

  const loginDuration = Math.round(performance.now() - loginStart);
  if (!loginRes.ok) {
    const errText = await loginRes.text();
    console.error(`❌ Login failed (${loginRes.status}): ${errText}`);
    process.exit(1);
  }

  const loginData = await loginRes.json();
  const token = loginData?.data?.accessToken || loginData?.accessToken;
  const user = loginData?.data?.user || loginData?.user;

  console.log(`✅ Login Successful in ${loginDuration}ms!`);
  console.log(`   User ID:   ${user?.id}`);
  console.log(`   Name:      ${user?.name}`);
  console.log(`   Email:     ${user?.email}`);
  console.log(`   JWT Token: ${token.substring(0, 20)}...${token.substring(token.length - 15)}\n`);

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  // 2. Discover active project
  let projectId = '4e61078c-0073-4d42-9970-75e5e106286a';
  try {
    const projRes = await fetch(`${BASE_URL}/api/projects`, { headers });
    if (projRes.ok) {
      const projData = await projRes.json();
      const list = projData?.data || projData?.projects || (Array.isArray(projData) ? projData : []);
      if (list.length > 0 && list[0].id) {
        projectId = list[0].id;
        console.log(`📁 Active Project Detected: "${list[0].name}" (${projectId})\n`);
      }
    }
  } catch (e) {
    console.warn('Could not discover projects automatically, using default project ID.');
  }

  // 3. Define test endpoints across ALL 10 functional modules + Health & Core
  const endpoints = [
    // ── 1. System & Health ───────────────────────────────────────────────────
    { module: 'Health & Core', method: 'GET', path: '/health', auth: false, expected: [200] },
    { module: 'Health & Core', method: 'GET', path: '/api/health', auth: false, expected: [200] },
    { module: 'Health & Core', method: 'GET', path: '/api/ai/health', auth: false, expected: [200] },

    // ── 2. Identity Domain ──────────────────────────────────────────────────
    { module: 'Identity', method: 'GET', path: '/auth/me', auth: true, expected: [200] },
    { module: 'Identity', method: 'GET', path: '/api/auth/sessions', auth: true, expected: [200] },
    { module: 'Identity', method: 'GET', path: `/api/authz/projects/${projectId}/permissions`, auth: true, expected: [200] },

    // ── 3. Project Management ────────────────────────────────────────────────
    { module: 'Project Management', method: 'GET', path: '/api/projects', auth: true, expected: [200] },
    { module: 'Project Management', method: 'GET', path: `/api/projects/${projectId}`, auth: true, expected: [200] },
    { module: 'Project Management', method: 'GET', path: `/api/projects/${projectId}/members`, auth: true, expected: [200] },
    { module: 'Project Management', method: 'GET', path: `/api/projects/${projectId}/overview`, auth: true, expected: [200] },

    // ── 4. Sticky Notes (Server-Authoritative Personal Scope) ────────────────
    { module: 'Sticky Notes', method: 'GET', path: '/api/v1/stickies', auth: true, expected: [200] },
    {
      module: 'Sticky Notes',
      method: 'POST',
      path: '/api/v1/stickies',
      auth: true,
      body: { title: 'Audit Sticky Note', content: '<p>Server Authoritative Verified</p>', color: 'yellow-1' },
      expected: [200, 201],
      cleanup: async (resData) => {
        const id = resData?.data?.id || resData?.id;
        if (id) {
          await fetch(`${BASE_URL}/api/v1/stickies/${id}`, { method: 'DELETE', headers });
        }
      },
    },

    // ── 5. Academic Library & Reference Manager ──────────────────────────────
    { module: 'Academic Library', method: 'GET', path: '/api/v1/library/items', auth: true, expected: [200] },
    { module: 'Academic Library', method: 'GET', path: `/api/v1/projects/${projectId}/library/items`, auth: true, expected: [200] },
    { module: 'Academic Library', method: 'GET', path: '/api/v1/library/collections', auth: true, expected: [200] },
    { module: 'Academic Library', method: 'GET', path: '/api/v1/library/collections/tree', auth: true, expected: [200] },
    { module: 'Academic Library', method: 'GET', path: '/api/v1/library/tags', auth: true, expected: [200] },
    { module: 'Academic Library', method: 'GET', path: '/api/v1/library/citation/styles', auth: true, expected: [200] },
    { module: 'Academic Library', method: 'GET', path: '/api/v1/library/curation/duplicates', auth: true, expected: [200] },
    { module: 'Academic Library', method: 'GET', path: '/api/v1/library/retraction/stats', auth: true, expected: [200] },
    { module: 'Academic Library', method: 'GET', path: '/api/v1/library/notes', auth: true, expected: [200] },
    { module: 'Academic Library', method: 'GET', path: '/api/v1/library/item-types', auth: true, expected: [200] },

    // ── 6. Academic Manuscript & Document (LaTeX) ────────────────────────────
    { module: 'Manuscript / LaTeX', method: 'GET', path: `/api/projects/${projectId}/pages`, auth: true, expected: [200] },
    { module: 'Manuscript / LaTeX', method: 'GET', path: `/api/projects/${projectId}/pages/tree`, auth: true, expected: [200] },

    // ── 7. AI Research Assistant ─────────────────────────────────────────────
    { module: 'AI Research Assistant', method: 'GET', path: '/api/ai/chats', auth: true, expected: [200] },
    { module: 'AI Research Assistant', method: 'GET', path: `/api/ai/memory/${user?.id || 'user'}`, auth: true, expected: [200] },

    // ── 8. Work Items & Cycles (Kanban) ──────────────────────────────────────
    { module: 'Work Items / Kanban', method: 'GET', path: `/api/projects/${projectId}/work-items`, auth: true, expected: [200] },
    { module: 'Work Items / Kanban', method: 'GET', path: `/api/projects/${projectId}/cycles`, auth: true, expected: [200] },
    { module: 'Work Items / Kanban', method: 'GET', path: `/api/projects/${projectId}/labels`, auth: true, expected: [200] },

    // ── 9. Storage & Cloud Drive ─────────────────────────────────────────────
    { module: 'Storage / Drive', method: 'GET', path: '/api/v1/storage/files/my-files', auth: true, expected: [200] },
    { module: 'Storage / Drive', method: 'GET', path: '/api/v1/storage/files/usage', auth: true, expected: [200] },

    // ── 10. Collaboration Activity Feed ──────────────────────────────────────
    { module: 'Activity Feed', method: 'GET', path: '/api/activity/feed', auth: true, expected: [200] },
    { module: 'Activity Feed', method: 'GET', path: '/api/activity/recent', auth: true, expected: [200] },

    // ── 11. Platform Analytics ───────────────────────────────────────────────
    { module: 'Analytics & Insights', method: 'GET', path: '/api/analytics/me/overview', auth: true, expected: [200] },
    { module: 'Analytics & Insights', method: 'GET', path: `/api/analytics/projects/${projectId}/overview`, auth: true, expected: [200] },
    { module: 'Analytics & Insights', method: 'GET', path: `/api/analytics/projects/${projectId}/labels`, auth: true, expected: [200] },
  ];

  console.log(`🔬 Step 2: Auditing ${endpoints.length} Routes Across All 10 Platform Modules...\n`);

  const results = [];

  for (const ep of endpoints) {
    const t0 = performance.now();
    const reqHeaders = ep.auth ? headers : { 'Content-Type': 'application/json' };
    const reqOptions = {
      method: ep.method,
      headers: reqHeaders,
    };
    if (ep.body) {
      reqOptions.body = JSON.stringify(ep.body);
    }

    try {
      const response = await fetch(`${BASE_URL}${ep.path}`, reqOptions);
      const latency = Math.round(performance.now() - t0);
      const isExpected = ep.expected.includes(response.status);

      let payload;
      const text = await response.text();
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text.substring(0, 60);
      }

      // Run cleanup callback if specified
      if (ep.cleanup && response.ok) {
        try { await ep.cleanup(payload); } catch {}
      }

      results.push({
        module: ep.module,
        method: ep.method,
        path: ep.path,
        status: response.status,
        latency,
        passed: isExpected,
        detail: typeof payload === 'object' ? (payload?.message || payload?.status || 'OK') : String(payload).substring(0, 30),
      });
    } catch (err) {
      const latency = Math.round(performance.now() - t0);
      results.push({
        module: ep.module,
        method: ep.method,
        path: ep.path,
        status: 'ERR',
        latency,
        passed: false,
        detail: err.message,
      });
    }
  }

  // 4. Formatted Display
  console.log('┌──────────────────────┬────────┬─────────────────────────────────────────────────┬────────┬──────────┬────────┐');
  console.log('│ Module               │ Method │ Endpoint Path                                   │ Status │ Latency  │ Result │');
  console.log('├──────────────────────┼────────┼─────────────────────────────────────────────────┼────────┼──────────┼────────┤');

  for (const r of results) {
    const mCol = r.module.padEnd(20).substring(0, 20);
    const methCol = r.method.padEnd(6);
    const pathCol = r.path.padEnd(47).substring(0, 47);
    const statusCol = String(r.status).padStart(6);
    const latCol = `${r.latency}ms`.padStart(8);
    const passCol = r.passed ? '  ✅ PASS ' : '  ❌ FAIL ';
    console.log(`│ ${mCol} │ ${methCol} │ ${pathCol} │ ${statusCol} │ ${latCol} │${passCol}│`);
  }

  console.log('└──────────────────────┴────────┴─────────────────────────────────────────────────┴────────┴──────────┴────────┘\n');

  const total = results.length;
  const passedCount = results.filter(r => r.passed).length;
  const failedCount = total - passedCount;

  console.log('========================================================================');
  console.log(`📊 AUDIT SUMMARY: ${passedCount}/${total} Routes PASSED (${Math.round((passedCount/total)*100)}%)`);
  if (failedCount === 0) {
    console.log('🎉 ALL SYSTEM MODULES, ROUTES, AND APIS ARE 100% HEALTHY & OPERATIONAL!');
  } else {
    console.log(`⚠️  ${failedCount} routes returned unexpected status.`);
  }
  console.log('========================================================================\n');
}

runAudit();
