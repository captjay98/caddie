"""Pydantic models: the serializable API contract shared by every endpoint."""

from pydantic import BaseModel, Field


class TaskCreate(BaseModel):
	title: str = Field(min_length=1, max_length=255)
	done: bool = False


class Task(TaskCreate):
	id: int
