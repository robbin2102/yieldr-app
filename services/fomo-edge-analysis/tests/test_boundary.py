from fastapi.testclient import TestClient
from main import app
client=TestClient(app)
def test_health_discloses_missing_source():
    assert client.get('/health').json()['source_complete'] is True

def test_no_secret_fails_closed(monkeypatch):
    monkeypatch.delenv('YIELDR_INTERNAL_SECRET',raising=False)
    assert client.get('/internal/capabilities').status_code==503

def test_capabilities_report_actual_version(monkeypatch):
    monkeypatch.setenv('YIELDR_INTERNAL_SECRET','test-only-token')
    assert client.get('/internal/capabilities').status_code==401
    c=client.get('/internal/capabilities',headers={'Authorization':'Bearer test-only-token'}).json()
    assert c['model_version']=='3.3.0' and c['rule_version']=='2026-09-09.2'
    assert c['missing_source']==[]

def test_queue_does_not_accept_wallet_override(monkeypatch):
    monkeypatch.setenv('YIELDR_INTERNAL_SECRET','test-only-token')
    assert client.post('/internal/scans',headers={'Authorization':'Bearer test-only-token'},json={'scan_id':'invalid','wallet':'anything'}).status_code==422
