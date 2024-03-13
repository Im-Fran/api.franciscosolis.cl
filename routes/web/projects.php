<?php

use App\Http\Controllers\Projects\ProjectController;

Route::apiResource('/projects', ProjectController::class)
    ->scoped([
        'projects' => 'slug',
    ]);
