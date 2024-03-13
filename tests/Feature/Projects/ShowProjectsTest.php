<?php

namespace Tests\Feature\Projects;

use App\Models\Projects\Project;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * @small
 */
class ShowProjectsTest extends TestCase {
    use RefreshDatabase;

    public function test_can_list_projects() {
        Project::factory()
            ->count(5)
            ->create();

        $response = $this->get(route('projects.index'));
        $response->assertJsonCount(5, 'data');
    }

    public function test_show_project_works() {
        Project::factory()
            ->create();

        $project = Project::first();
        $response = $this->get(route('projects.show', $project));

        $response->assertStatus(200);
        $response->assertSimilarJson([
            'data' => [
                'name' => $project->name,
                'slug' => $project->slug,
                'tagline' => $project->tagline,
                'description' => $project->description,
                'display_image' => $project->display_image,
                'body' => $project->body,
                'created_at' => $project->created_at,
                'updated_at' => $project->updated_at,
            ],
        ]);
    }

    public function test_projects_fields_parameter() {
        Project::factory()
            ->create();

        $response = $this->get(route('projects.index', [
            'fields' => 'name,slug',
        ]));

        $response->assertStatus(200);
        $response->assertJsonStructure([
            'data' => [
                '*' => [
                    'name',
                    'slug',
                ],
            ],
        ]);
    }
}
