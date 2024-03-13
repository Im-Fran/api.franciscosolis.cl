<?php

use Illuminate\Support\Facades\Route;

Route::get('/', fn () => ['status' => 'ok']);

foreach (glob(__DIR__.'/web/*.php') as $filename) {
    require $filename;
}
