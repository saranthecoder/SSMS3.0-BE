import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '10s', target: 25 },   // Ramp-up to 25 VUs
    { duration: '10s', target: 50 },   // Ramp-up to 50 VUs
    { duration: '10s', target: 100 },  // Ramp-up to 100 VUs
    { duration: '10s', target: 200 },  // Peak at 200 VUs
    { duration: '5s', target: 0 },     // Ramp-down
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],    // Error rate must be < 1%
    http_req_duration: ['p(95)<500'],  // 95% of requests must complete in < 500ms
  },
};

const BASE_URL = __ENV.TARGET_URL || 'http://localhost:3000';

export default function () {
  // 1. Health probe
  const healthRes = http.get(`${BASE_URL}/api/health`);
  check(healthRes, {
    'health status is 200': (r) => r.status === 200,
  });

  // 2. Readiness check
  const readyRes = http.get(`${BASE_URL}/api/health/readiness`);
  check(readyRes, {
    'readiness status is 200': (r) => r.status === 200,
  });

  // 3. Batch query
  const batchRes = http.get(`${BASE_URL}/api/batches`);
  check(batchRes, {
    'batch query status is 200': (r) => r.status === 200,
  });

  sleep(0.5);
}
