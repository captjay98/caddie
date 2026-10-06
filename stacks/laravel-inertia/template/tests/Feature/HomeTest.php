<?php

namespace Tests\Feature;

use App\Models\Task;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class HomeTest extends TestCase
{
	use RefreshDatabase;

	protected function setUp(): void
	{
		parent::setUp();
		// The recipe runs the suite BEFORE the client build; @vite has no
		// manifest yet and the page markup is not what these tests assert.
		$this->withoutVite();
	}

	public function test_home_page_renders_the_task_list_from_the_database(): void
	{
		Task::create(['title' => 'Ship the fixture', 'done' => false]);
		Task::create(['title' => 'Close the packet', 'done' => true]);

		$response = $this->get('/');

		$response->assertOk();
		$response->assertInertia(fn ($page) => $page
			->component('Home')
			->has('tasks', 2)
			->where('tasks.0.title', 'Ship the fixture')
			->where('tasks.1.done', true));
	}

	public function test_a_task_can_be_created_through_the_validated_route(): void
	{
		$response = $this->post('/tasks', ['title' => 'Write the live spec']);

		$response->assertRedirect('/');
		$this->assertDatabaseHas('tasks', ['title' => 'Write the live spec', 'done' => false]);

		$this->get('/')->assertInertia(fn ($page) => $page
			->where('tasks.0.title', 'Write the live spec'));
	}

	public function test_an_empty_title_is_rejected_with_a_session_error(): void
	{
		$response = $this->from('/')->post('/tasks', ['title' => '']);

		$response->assertRedirect('/');
		$response->assertSessionHasErrors(['title']);
		$this->assertDatabaseCount('tasks', 0);
	}
}
