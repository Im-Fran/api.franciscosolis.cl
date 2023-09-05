<?php

namespace App\Http\Controllers\Account;

use App\Http\Controllers\Controller;
use App\Http\Requests\Account\AccountInformationRequest;
use Illuminate\Http\Request;

class AccountInformationController extends Controller {
    public function index(Request $request) {
        $user = $request->user();

        return [
            'name' => $user->name,
            'email' => $user->email,
        ];
    }

    public function update(AccountInformationRequest $request) {
        $user = $request->user();
        $user->update([
            'name' => $request->input('name'),
            'email' => $request->input('email'),
        ]);

        return response()->json([
            'message' => 'Account information updated successfully.',
        ]);
    }
}
