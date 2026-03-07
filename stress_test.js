import http from 'k6/http';
import { check, sleep } from 'k6';

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
    message: "Olá, meu CPF é 123.456.789-00 e preciso de uma análise de crédito."
  });

  const params = {
    headers: {
      'Authorization': 'Bearer sk-govai-19b8f4ac0bda484f9af97be3',
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
