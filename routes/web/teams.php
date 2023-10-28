<?php

use App\Http\Controllers\Teams;
use Illuminate\Support\Facades\Route;

Route::prefix('/teams')->group(function(){
    Route::get('/', [Teams\TeamController::class, 'index'])
        ->name('teams.index');
    Route::post('/', [Teams\TeamController::class, 'store'])
        ->name('teams.store');

    Route::prefix('/{team}')->group(function(){
        Route::get('/', [Teams\TeamController::class, 'show'])
            ->name('teams.show');
    });
});
