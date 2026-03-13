import http from 'k6/http';
import { check, sleep } from 'k6';

// A API key NUNCA deve ser hardcoded aqui.
// Execute via: k6 run -e GOVAI_STRESS_TEST_KEY=sk-govai-... stress_test.js
// Veja .github/SECRETS.md para instruções de geração de chaves de teste.
const API_KEY = __ENV.GOVAI_STRESS_TEST_KEY;
if (!API_KEY) {
  throw new Error(
    'GOVAI_STRESS_TEST_KEY não definida. ' +
    'Execute: k6 run -e GOVAI_STRESS_TEST_KEY=sua_chave stress_test.js'
  );
}

export let options = {
  stages: [
    { duration: '30s', target: 20 }, // Sobe para 20 usuários em 30s
    { duration: '1m', target: 20 },  // Mantém 20 usuários por 1 minuto
    { duration: '30s', target: 0 },  // Desce para 0
  ],
};

export default function () {
  const url = 'http://localhost:3000/v1/execute/11111111-1111-1111-1111-111111111111';
  const payload = JSON.stringify({
    message: "Olá, preciso de uma análise de crédito para o contrato número 2024/0042."
  });

  const params = {
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'x-org-id': '00000000-0000-0000-0000-000000000001',
      'Content-Type': 'application/json',
    },
  };

  let res = http.post(url, payload, params);

  check(res, {
    'status is 200': (r) => r.status === 200,
    'has traceId': (r) => r.json()._govai && r.json()._govai.traceId,
  });

  sleep(1);
}
