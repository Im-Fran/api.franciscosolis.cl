<?php

namespace App\Http\Controllers\Account;

use App\Http\Controllers\Controller;
use App\Http\Requests\Account\PasswordUpdateRequest;
use Illuminate\Support\Facades\Hash;

class AccountPasswordController extends Controller {
    public function __invoke(PasswordUpdateRequest $request) {
        $user = $request->user();
        $currentPassword = $request->input('current_password');
        if (Hash::check($currentPassword, $user->password) === false) {
            return response()->json([
                'message' => 'The provided password does not match your current password.',
            ], 401);
        }

        $password = $request->input('password');

        $user->update([
            'password' => Hash::make($password),
        ]);

        return response()->json([
            'message' => 'Password updated successfully.',
        ]);
    }
}
