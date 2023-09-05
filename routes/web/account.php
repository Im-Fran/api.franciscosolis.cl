<?php

use App\Http\Controllers\Account;

Route::prefix('account')->name('account.')->group(function() {
    Route::get('information', [Account\AccountInformationController::class, 'index'])->name('information');
    Route::post('information', [Account\AccountInformationController::class, 'update']);

    Route::post('password', Account\AccountPasswordController::class)->name('password');
});
