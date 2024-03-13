<?php

namespace Tests\Feature\Projects;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Tests\TestCase;

/**
 * @small
 */
class CreateProjectTest extends TestCase {
    use RefreshDatabase;

    public function test_cannot_create_project(): void {
        $user = User::factory()->create([
            'email' => 'imfran@example.com',
        ]);

        $response = $this->actingAs($user)->post('/projects', [
            'name' => fake()->name,
            'tagline' => fake()->sentence,
            'description' => fake()->sentences,
            'display_image' => fake()->image,
            'body' => fake()->text,
        ]);

        $response->assertStatus(403);
    }

    public function test_can_create_project(): void {
        $user = User::factory()->create([
            'email' => 'imfran@duck.com',
        ]);

        $response = $this->actingAs($user)->post('/projects', [
            'name' => fake()->name,
            'tagline' => fake()->sentence,
            'description' => fake()->sentences(asText: true),
            'display_image' => UploadedFile::fake()->image('display_image.jpg'),
            'body' => fake()->text,
        ]);

        $response->assertStatus(201);
    }
}
