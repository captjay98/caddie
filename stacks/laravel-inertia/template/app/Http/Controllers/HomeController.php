<?php

namespace App\Http\Controllers;

use App\Models\Task;
use Inertia\Inertia;
use Inertia\Response;

class HomeController extends Controller
{
	public function index(): Response
	{
		return Inertia::render('Home', [
			'tasks' => Task::query()
				->orderBy('created_at')
				->get(['id', 'title', 'done']),
		]);
	}
}
