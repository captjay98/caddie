<?php

namespace App\Http\Controllers;

use App\Models\Task;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;

class TaskController extends Controller
{
	public function store(Request $request): RedirectResponse
	{
		$validated = $request->validate([
			'title' => ['required', 'string', 'max:255'],
		]);

		Task::create($validated + ['done' => false]);

		return back();
	}
}
