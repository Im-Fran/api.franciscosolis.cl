<?php

namespace App\Http\Controllers\Teams;

use App\Http\Controllers\Controller;
use App\Http\Requests\Teams\CreateTeamRequest;
use App\Http\Resources\TeamResource;
use App\Models\Teams\Team;
use Spatie\QueryBuilder\QueryBuilder;

class TeamController extends Controller {

    public function index() {
        $teams = QueryBuilder::for(Team::class)
            ->allowedFilters(['id', 'name', 'user_id', 'created_at', 'updated_at'])
            ->allowedSorts(['name', 'created_at', 'updated_at'])
            ->allowedFields([
                'teams.id',
                'teams.name',
            ])
            ->allowedIncludes(['user'])
            ->paginate(min(request()->input('per_page', 10), 50), ['teams.*']);

        return TeamResource::collection($teams);
    }

    public function show(Team $team) {
        $team = QueryBuilder::for(Team::class)
            ->allowedIncludes(['user', 'members'])
            ->findOrFail($team->id);

        return new TeamResource($team);
    }

    // Creates a new team.
    public function store(CreateTeamRequest $request) {
        return new TeamResource(Team::create(array_merge($request->validated(), [
            'user_id' => auth()->id(),
        ])));
    }
}
