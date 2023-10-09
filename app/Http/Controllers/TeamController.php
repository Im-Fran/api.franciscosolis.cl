<?php

namespace App\Http\Controllers;

use App\Http\Resources\TeamResource;
use App\Models\Team;
use Illuminate\Http\Request;

class TeamController extends Controller
{
    public function index()
    {
        return TeamResource::collection(Team::all());
    }

    public function store(Request $request)
    {
        $request->validate([
            'user_id' => ['required', 'integer'],
            'name' => ['required'],
            'bio' => ['required'],
            'website' => ['nullable'],
            'links' => ['nullable'],
        ]);

        return new TeamResource(Team::create($request->validated()));
    }

    public function show(Team $team)
    {
        return new TeamResource($team);
    }

    public function update(Request $request, Team $team)
    {
        $request->validate([
            'user_id' => ['required', 'integer'],
            'name' => ['required'],
            'bio' => ['required'],
            'website' => ['nullable'],
            'links' => ['nullable'],
        ]);

        $team->update($request->validated());

        return new TeamResource($team);
    }

    public function destroy(Team $team)
    {
        $team->delete();

        return response()->json();
    }
}
