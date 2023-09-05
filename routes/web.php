<?php

use Illuminate\Support\Facades\Route;

Route::get('/', fn () => ['status' => 'ok']);

// Dynamically load all routes from the web folder
foreach (glob(__DIR__.'/web/*.php') as $filename) {
    require $filename;
}
