"""The FastAPI application: health probe + a real task resource.

State lives server-side for the life of the process (the full-stack behavior
the stack gate proves); durable storage is the first user-project change,
never template scaffolding. CORS is an explicit allowlist read from
CADDIE_CLIENT_ORIGIN — unset means same-origin only, never a wildcard.
"""

import os

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .models import Task, TaskCreate

app = FastAPI(title="forge-fastapi-template")

_allowed_origins = [origin for origin in os.environ.get("CADDIE_CLIENT_ORIGIN", "").split(",") if origin]
if _allowed_origins:
	app.add_middleware(
		CORSMiddleware,
		allow_origins=_allowed_origins,
		allow_methods=["GET", "POST"],
		allow_headers=["content-type"],
	)

_tasks: dict[int, Task] = {}
_next_id = 1


@app.get("/api/health")
def health() -> dict[str, bool]:
	return {"ok": True}


@app.get("/api/tasks", response_model=list[Task])
def list_tasks() -> list[Task]:
	return sorted(_tasks.values(), key=lambda task: task.id)


@app.post("/api/tasks", response_model=Task, status_code=201)
def create_task(payload: TaskCreate) -> Task:
	global _next_id
	task = Task(id=_next_id, **payload.model_dump())
	_tasks[task.id] = task
	_next_id += 1
	return task


@app.get("/api/tasks/{task_id}", response_model=Task)
def get_task(task_id: int) -> Task:
	task = _tasks.get(task_id)
	if task is None:
		raise HTTPException(status_code=404, detail="task_not_found")
	return task
