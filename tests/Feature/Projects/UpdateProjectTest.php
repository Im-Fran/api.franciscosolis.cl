<?php

namespace Tests\Feature\Projects;

use App\Models\Projects\Project;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * @small
 */
class UpdateProjectTest extends TestCase {
    use RefreshDatabase;

    public function test_cannot_update_project() {
        $user = User::factory()->create();
        $project = Project::factory()->create();

        $response = $this->actingAs($user)->patchJson(route('projects.update', [$project->slug]), [
            'name' => 'New Name',
            'description' => 'New Description',
        ]);

        $response->assertStatus(403);
    }

    public function test_can_update_project() {
        $user = User::factory()->create([
            'email' => 'imfran@duck.com',
        ]);
        $project = Project::factory()->create();

        $response = $this->actingAs($user)->patchJson(route('projects.update', [$project->slug]), [
            'name' => 'New Name',
            'description' => 'New Description',
        ]);

        $response->assertStatus(200);
        $this->assertDatabaseHas('projects', [
            'id' => $project->id,
            'name' => 'New Name',
            'description' => 'New Description',
        ]);
    }
}
