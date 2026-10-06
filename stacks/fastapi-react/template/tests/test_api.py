"""API contract tests against the real ASGI app (no network server needed)."""

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_answers_ok():
	response = client.get("/api/health")
	assert response.status_code == 200
	assert response.json() == {"ok": True}


def test_created_tasks_persist_across_requests():
	created = client.post("/api/tasks", json={"title": "prove the API"})
	assert created.status_code == 201
	task = created.json()
	assert task["title"] == "prove the API"
	assert task["done"] is False

	assert task in client.get("/api/tasks").json()
	assert client.get(f"/api/tasks/{task['id']}").json() == task


def test_blank_title_is_rejected_with_422():
	response = client.post("/api/tasks", json={"title": ""})
	assert response.status_code == 422


def test_unknown_task_is_a_typed_404():
	response = client.get("/api/tasks/99999")
	assert response.status_code == 404
	assert response.json() == {"detail": "task_not_found"}
