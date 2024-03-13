<?php

namespace App\Http\Controllers\Projects;

use App\Http\Controllers\Controller;
use App\Http\Requests\Projects\CreateProjectRequest;
use App\Http\Requests\Projects\UpdateProjectRequest;
use App\Http\Resources\Projects\ProjectResource;
use App\Models\Projects\Project;
use Spatie\QueryBuilder\QueryBuilder;

class ProjectController extends Controller {
    /* Display a listing of the projects. */
    public function index() {
        return ProjectResource::collection(QueryBuilder::for(Project::class)
            ->allowedFilters(['name', 'slug', 'tagline', 'description', 'body'])
            ->allowedSorts(['name', 'slug', 'created_at', 'updated_at'])
            ->paginate());
    }

    /* Display the given project resource */
    public function show(Project $project) {
        return new ProjectResource($project);
    }

    /* Stores a new project */
    public function store(CreateProjectRequest $request) {
        $data = array_merge($request->all(), [
            'display_image' => $request->file('display_image')->storePublicly(),
        ]);

        return new ProjectResource(Project::create($data));
    }

    /* Updates the given project with the given information */
    public function update(UpdateProjectRequest $request, Project $project) {
        $project->update($request->all());

        return new ProjectResource($project);
    }

    /* Destroys the given object */
    public function destroy(Project $project) {
        $project->delete();

        return response()->json([], 204);
    }
}
